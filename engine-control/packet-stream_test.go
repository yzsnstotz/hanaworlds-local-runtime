package main

import (
	mt "github.com/HimbeerserverDE/mt"
	"io"
	"testing"
	"time"
)

const testNonce = "0123456789abcdef0123456789abcdef"

func shutdownPacket(nonce string) mt.Pkt {
	return mt.Pkt{Cmd: &mt.ToCltKick{Reason: mt.Shutdown, Custom: "hanaworlds_control_" + nonce}}
}

type closedPeer struct {
	packets []mt.Pkt
	closed  chan struct{}
}

func (p *closedPeer) Closed() <-chan struct{} { return p.closed }
func (p *closedPeer) Recv() (mt.Pkt, error) {
	if len(p.packets) == 0 {
		return mt.Pkt{}, io.EOF
	}
	packet := p.packets[0]
	p.packets = p.packets[1:]
	return packet, nil
}
func TestReceivedShutdownSurvivesPeerClose(t *testing.T) {
	// Both branches are ready in the former select. Exercise the finite scheduling
	// alternatives; no network, command retries or elapsed-time assumptions.
	for range 32 {
		s := newNativePacketStream()
		s.expectedStop.Store(testNonce)
		closed := make(chan struct{})
		close(closed)
		s.receive(&closedPeer{[]mt.Pkt{shutdownPacket(testNonce)}, closed}, make(chan struct{}))
		p, ok := <-s.packets
		if !ok || !matchesShutdown(p.Cmd, testNonce) {
			t.Fatal("received matching Shutdown discarded on peer close")
		}
		if got := s.observation(); got.MatchedReceived != 1 || got.MatchedQueued != 1 || got.MatchedDropped != 0 {
			t.Fatalf("bad handoff counters: %+v", got)
		}
	}
}
func TestQueuedShutdownPrecedesReceiveEnd(t *testing.T) {
	for range 32 {
		s := newNativePacketStream()
		s.packets <- shutdownPacket(testNonce)
		close(s.packets)
		close(s.failure)
		p, err := s.next(nil)
		if err != nil || !matchesShutdown(p.Cmd, testNonce) {
			t.Fatal("receive end overtook queued Shutdown", err)
		}
		if _, err = s.next(nil); err == nil || err.Error() != "CHANNEL_CLOSED" {
			t.Fatal("missing close rejection")
		}
	}
}
func TestShutdownQueuePreservesPriorRejection(t *testing.T) {
	s := newNativePacketStream()
	prior := mt.Pkt{Cmd: &mt.ToCltKick{Reason: mt.Custom, Custom: "denied"}}
	s.packets <- prior
	s.packets <- shutdownPacket(testNonce)
	close(s.packets)
	close(s.failure)
	p, err := s.next(nil)
	if err != nil || p.Cmd != prior.Cmd || matchesShutdown(p.Cmd, testNonce) {
		t.Fatal("later ack bypassed prior rejection", err)
	}
}
func TestShutdownRequiresMatchingReasonAndNonce(t *testing.T) {
	for _, p := range []mt.Pkt{shutdownPacket("fedcba9876543210fedcba9876543210"), {Cmd: &mt.ToCltKick{Reason: mt.Custom, Custom: "hanaworlds_control_" + testNonce}}, {Cmd: &mt.ToCltChatMsg{Text: "hanaworlds_control_" + testNonce}}} {
		if matchesShutdown(p.Cmd, testNonce) {
			t.Fatal("unrelated packet accepted")
		}
	}
	if matchesShutdown(shutdownPacket(testNonce).Cmd, "") {
		t.Fatal("empty nonce accepted")
	}
	s := newNativePacketStream()
	close(s.packets)
	close(s.failure)
	if _, err := s.next(nil); err == nil || err.Error() != "CHANNEL_CLOSED" {
		t.Fatal("bare close authorized")
	}
	timeout := make(chan time.Time, 1)
	timeout <- time.Now()
	if _, err := newNativePacketStream().next(timeout); err == nil || err.Error() != "CURRENT_PERMISSION_UNPROVEN" {
		t.Fatal("timeout accepted")
	}
}

func TestPacketReceiverCancelsWhileQueueFull(t *testing.T) {
	s := newNativePacketStream()
	s.expectedStop.Store(testNonce)
	for range cap(s.packets) {
		s.packets <- mt.Pkt{Cmd: &mt.ToCltChatMsg{Text: "queued"}}
	}
	cancelled := make(chan struct{})
	close(cancelled)
	closed := make(chan struct{})
	close(closed)
	s.receive(&closedPeer{[]mt.Pkt{shutdownPacket(testNonce)}, closed}, cancelled)
	select {
	case <-s.failure:
	default:
		t.Fatal("receiver leaked on local teardown")
	}
	if got := s.observation(); got.MatchedReceived != 1 || got.MatchedQueued != 0 || got.MatchedDropped != 1 {
		t.Fatalf("bad cancellation counters: %+v", got)
	}
}
