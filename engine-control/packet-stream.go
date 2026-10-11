package main

import (
	"encoding/json"
	"errors"
	mt "github.com/HimbeerserverDE/mt"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

type nativePeer interface {
	Recv() (mt.Pkt, error)
}
type nativePacketStream struct {
	packets                                        chan mt.Pkt
	failure                                        chan struct{}
	expectedStop                                   atomic.Value
	matchedReceived, matchedQueued, matchedDropped atomic.Int64
}

func newNativePacketStream() *nativePacketStream {
	s := &nativePacketStream{packets: make(chan mt.Pkt, 64), failure: make(chan struct{})}
	s.expectedStop.Store("")
	return s
}
func matchesShutdown(cmd mt.Cmd, nonce string) bool {
	kick, ok := cmd.(*mt.ToCltKick)
	return ok && nonce != "" && kick.Reason == mt.Shutdown && strings.Contains(kick.Custom, "hanaworlds_control_"+nonce)
}
func (s *nativePacketStream) observation() stopObservation {
	return stopObservation{s.matchedReceived.Load(), s.matchedQueued.Load(), s.matchedDropped.Load(), len(s.packets)}
}

// Once Recv has returned a packet, transport closure cannot revoke it. Deliver
// received packets in FIFO order, then close the stream. Only local teardown may
// interrupt delivery so a full queue cannot leak the receiver after run returns.
func (s *nativePacketStream) receive(peer nativePeer, cancelled <-chan struct{}) {
	defer close(s.failure)
	defer close(s.packets)
	received := 0
	fullReported := false
	for {
		p, err := peer.Recv()
		if err != nil {
			nativeStreamTrace("receive-ended", received, len(s.packets), errors.Is(err, net.ErrClosed))
			return
		}
		received++
		if len(s.packets) == cap(s.packets) && !fullReported {
			fullReported = true
			nativeStreamTrace("queue-full", received, len(s.packets), false)
		}
		matched := matchesShutdown(p.Cmd, s.expectedStop.Load().(string))
		if matched {
			s.matchedReceived.Add(1)
		}
		select {
		case s.packets <- p:
			if matched {
				s.matchedQueued.Add(1)
			}
		case <-cancelled:
			if matched {
				s.matchedDropped.Add(1)
			}
			return
		}
	}
}

// A closed channel yields buffered packets before EOF, preserving native errors
// before any later acknowledgement. EOF alone never proves shutdown.
func (s *nativePacketStream) next(timeout <-chan time.Time) (mt.Pkt, error) {
	select {
	case <-timeout:
		return mt.Pkt{}, errors.New("CURRENT_PERMISSION_UNPROVEN")
	case p, ok := <-s.packets:
		if !ok {
			return mt.Pkt{}, errors.New("CHANNEL_CLOSED")
		}
		return p, nil
	}
}

func nativeStreamTrace(stage string, received, pending int, closed bool) {
	_ = json.NewEncoder(os.Stderr).Encode(struct {
		Stage           string `json:"stage"`
		Received        int    `json:"received"`
		Pending         int    `json:"pending"`
		TransportClosed bool   `json:"transportClosed"`
	}{stage, received, pending, closed})
}
