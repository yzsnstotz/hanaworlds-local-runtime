// The private Host helper authenticates an existing native account. It never
// registers accounts, reads the auth database or accepts arbitrary chat commands.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	mt "github.com/HimbeerserverDE/mt"
	"github.com/HimbeerserverDE/srp"
	"net"
	"os"
	"regexp"
	"strings"
	"time"
)

type request struct {
	Op, Nonce, Username, Password string
	Port                          int
}
type response struct {
	Status          string           `json:"status"`
	Nonce           string           `json:"nonce,omitempty"`
	StopObservation *stopObservation `json:"stopObservation,omitempty"`
}

type stopObservation struct {
	MatchedReceived int64 `json:"matchedReceived"`
	MatchedQueued   int64 `json:"matchedQueued"`
	MatchedDropped  int64 `json:"matchedDropped"`
	PendingPackets  int   `json:"pendingPackets"`
}
type stopFailure struct{ observation stopObservation }

func (e *stopFailure) Error() string { return "CHANNEL_CLOSED" }

var noncePattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
var playerPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,20}$`)
var translations = regexp.MustCompile("\x1b\\(T@__builtin\\)|\x1b[FET]")

func cleanNative(s string) string { return translations.ReplaceAllString(s, "") }
func validProbeReply(kind uint8, sender, text, nonce string) bool {
	return kind == 0 && sender == "" && cleanNative(text) == nonce+" = <not set>"
}

var floodReply = regexp.MustCompile(`^You cannot send more messages\. You are limited to [0-9]+(?:\.[0-9]+)? messages per 10 seconds\.$`)

func nativeFailure(kind uint8, sender, text string) string {
	if sender != "" {
		return ""
	}
	text = cleanNative(text)
	if kind == uint8(mt.SysMsg) && floodReply.MatchString(text) {
		return "NATIVE_CHAT_RATE_LIMITED"
	}
	if kind == uint8(mt.RawMsg) && strings.Contains(text, "missing privileges:") {
		return "NATIVE_PERMISSION_DENIED"
	}
	return ""
}
func commandFor(r request) (string, error) {
	if !noncePattern.MatchString(r.Nonce) {
		return "", errors.New("INVALID_REQUEST")
	}
	switch r.Op {
	case "probe":
		return "/set hanaworlds_probe_" + r.Nonce, nil
	case "stop":
		return "/shutdown 0 hanaworlds_control_" + r.Nonce, nil
	}
	return "", errors.New("INVALID_REQUEST")
}

// Luanti 5.17 refills limit/8 tokens each integer second. The owned Host
// pins the unchanged default limit of 8. Never spend the initial burst allowance.
type commandBudget struct{ next time.Time }

func (b commandBudget) delay(now time.Time) time.Duration {
	if now.Before(b.next) {
		return b.next.Sub(now)
	}
	return 0
}
func (b *commandBudget) sent(now time.Time) { b.next = now.Add(time.Second) }

func emit(status, nonce string) {
	_ = json.NewEncoder(os.Stdout).Encode(response{Status: status, Nonce: nonce})
}
func run() error {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 65536)
	read := func() (request, error) {
		var r request
		if !scanner.Scan() {
			return r, errors.New("INPUT_CLOSED")
		}
		if json.Unmarshal(scanner.Bytes(), &r) != nil {
			return r, errors.New("INVALID_REQUEST")
		}
		return r, nil
	}
	r, e := read()
	if e != nil {
		return e
	}
	if r.Op != "connect" || !playerPattern.MatchString(r.Username) || r.Password == "" || r.Port < 1 || r.Port > 65535 {
		return errors.New("INVALID_LOGIN")
	}
	conn, e := net.Dial("udp", fmt.Sprintf("127.0.0.1:%d", r.Port))
	if e != nil {
		return errors.New("CHANNEL_UNAVAILABLE")
	}
	peer := mt.Connect(conn)
	defer peer.Close()
	stream := newNativePacketStream()
	cancelled := make(chan struct{})
	defer close(cancelled)
	go stream.receive(peer, cancelled)
	packets, failure := stream.packets, stream.failure
	send := func(cmd mt.Cmd) error { _, e := peer.SendCmd(cmd); return e }
	if send(&mt.ToSrvNil{}) != nil {
		return errors.New("CHANNEL_UNAVAILABLE")
	}
	init := &mt.ToSrvInit{SerializeVer: 29, MinProtoVer: 53, MaxProtoVer: 53, PlayerName: r.Username}
	if send(init) != nil {
		return errors.New("CHANNEL_UNAVAILABLE")
	}
	retry := time.NewTicker(time.Second)
	defer retry.Stop()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	var A, a []byte
	hello, authenticated, ready := false, false, false
	for !ready {
		select {
		case <-failure:
			return errors.New("CHANNEL_CLOSED")
		case <-deadline.C:
			return errors.New("LOGIN_TIMEOUT")
		case <-retry.C:
			if !hello {
				if send(init) != nil {
					return errors.New("CHANNEL_UNAVAILABLE")
				}
			}
		case pkt, ok := <-packets:
			if !ok {
				return errors.New("CHANNEL_CLOSED")
			}
			switch cmd := pkt.Cmd.(type) {
			case *mt.ToCltHello:
				if hello || cmd.ProtoVer != 53 || cmd.AuthMethods&mt.SRP == 0 {
					return errors.New("EXISTING_SRP_ACCOUNT_REQUIRED")
				}
				hello = true
				A, a, e = srp.InitiateHandshake()
				if e != nil {
					return errors.New("AUTH_FAILED")
				}
				if send(&mt.ToSrvSRPBytesA{A: A, NoSHA1: true}) != nil {
					return errors.New("CHANNEL_UNAVAILABLE")
				}
			case *mt.ToCltSRPBytesSaltB:
				if !hello || authenticated || len(A) == 0 {
					return errors.New("AUTH_FAILED")
				}
				K, e := srp.CompleteHandshake(A, a, []byte(strings.ToLower(r.Username)), []byte(r.Password), cmd.Salt, cmd.B)
				if e != nil {
					return errors.New("AUTH_FAILED")
				}
				// Luanti hashes lowercase username for x, but the original case for M.
				proof := srp.ClientProof([]byte(r.Username), cmd.Salt, A, cmd.B, K)
				if send(&mt.ToSrvSRPBytesM{M: proof}) != nil {
					return errors.New("CHANNEL_UNAVAILABLE")
				}
				r.Password = ""
				A = nil
				a = nil
			case *mt.ToCltAcceptAuth:
				if !hello || authenticated || r.Password != "" {
					return errors.New("AUTH_FAILED")
				}
				authenticated = true
				if send(&mt.ToSrvInit2{Lang: "en"}) != nil {
					return errors.New("CHANNEL_UNAVAILABLE")
				}
			case *mt.ToCltCSMRestrictionFlags:
				if !authenticated {
					return errors.New("AUTH_FAILED")
				}
				ready = true
				if send(&mt.ToSrvCltReady{Major: 5, Minor: 17, Version: "HanaWorlds native management", Formspec: 4}) != nil {
					return errors.New("CHANNEL_UNAVAILABLE")
				}
			case *mt.ToCltKick:
				return errors.New("AUTH_DENIED")
			}
		}
	}
	emit("AUTHENTICATED", "")
	requests := make(chan requestResult)
	go func() {
		for {
			value, err := read()
			select {
			case requests <- requestResult{value, err}:
			case <-cancelled:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	var budget commandBudget
	for {
		r, e = waitForRequest(requests, stream)
		if e != nil {
			return e
		}
		cmd, e := commandFor(r)
		if e != nil {
			return e
		}
		// This is admission before transmission, not a retry of a rejected query.
		slot := time.NewTimer(budget.delay(time.Now()))
		if err := waitForCommandSlot(slot.C, stream); err != nil {
			slot.Stop()
			return err
		}
		if r.Op == "stop" {
			stream.expectedStop.Store(r.Nonce)
		}
		if send(&mt.ToSrvChatMsg{Msg: cmd}) != nil {
			return errors.New("CHANNEL_UNAVAILABLE")
		}
		budget.sent(time.Now())
		timer := time.NewTimer(5 * time.Second)
		complete := false
		for !complete {
			pkt, err := stream.next(timer.C)
			if err != nil {
				timer.Stop()
				if r.Op == "stop" && err.Error() == "CHANNEL_CLOSED" {
					return &stopFailure{stream.observation()}
				}
				return err
			}
			switch msg := pkt.Cmd.(type) {
			case *mt.ToCltChatMsg:
				if r.Op == "probe" && validProbeReply(uint8(msg.Type), msg.Sender, msg.Text, "hanaworlds_probe_"+r.Nonce) {
					complete = true
					emit("CURRENT", r.Nonce)
				}
				if code := nativeFailure(uint8(msg.Type), msg.Sender, msg.Text); code != "" {
					timer.Stop()
					return errors.New(code)
				}
			case *mt.ToCltKick:
				if r.Op == "stop" && matchesShutdown(msg, r.Nonce) {
					timer.Stop()
					seen := stream.observation()
					_ = json.NewEncoder(os.Stdout).Encode(response{Status: "NATIVE_SHUTDOWN", Nonce: r.Nonce, StopObservation: &seen})
					return nil
				}
				timer.Stop()
				return errors.New("CHANNEL_CLOSED")
			}
		}
		timer.Stop()
	}
}
func main() {
	if e := run(); e != nil {
		if stopped, ok := e.(*stopFailure); ok {
			_ = json.NewEncoder(os.Stdout).Encode(response{Status: e.Error(), StopObservation: &stopped.observation})
		} else {
			emit(e.Error(), "")
		}
		os.Exit(1)
	}
}
