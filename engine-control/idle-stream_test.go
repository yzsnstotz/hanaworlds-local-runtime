package main

import (
	mt "github.com/HimbeerserverDE/mt"
	"testing"
	"time"
)

func TestIdleNativeTrafficCannotBlockNextManagementRequest(t *testing.T) {
	stream := newNativePacketStream()
	requests := make(chan requestResult, 1)
	cancelled, produced, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(produced)
		for range 256 {
			select {
			case stream.packets <- mt.Pkt{Cmd: &mt.ToCltTimeOfDay{}}:
			case <-cancelled:
				return
			}
		}
		requests <- requestResult{value: request{Op: "probe", Nonce: testNonce}}
	}()
	go func() {
		defer close(done)
		value, err := waitForRequest(requests, stream)
		if err != nil || value.Nonce != testNonce {
			t.Error("request lost", err)
		}
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Error("idle traffic filled queue and blocked the management request")
		close(cancelled)
		<-produced
		requests <- requestResult{value: request{Op: "probe", Nonce: testNonce}}
		<-done
	}
	<-produced
}

func TestIdleRejectionIsNeverTreatedAsPermission(t *testing.T) {
	for _, packet := range []mt.Pkt{
		{Cmd: &mt.ToCltKick{Reason: mt.Custom}},
		{Cmd: &mt.ToCltChatMsg{Type: mt.RawMsg, Text: "You don't have permission to run this command (missing privileges: server)"}},
	} {
		stream := newNativePacketStream()
		stream.packets <- packet
		if _, err := waitForRequest(make(chan requestResult), stream); err == nil {
			t.Fatal("idle rejection ignored")
		}
		stream.packets <- packet
		if err := waitForCommandSlot(make(chan time.Time), stream); err == nil {
			t.Fatal("admission rejection ignored")
		}
	}
	stream := newNativePacketStream()
	close(stream.packets)
	if _, err := waitForRequest(make(chan requestResult), stream); err == nil {
		t.Fatal("closed stream revived")
	}
}
func TestIdleProbeTextCannotAnswerAFutureRequest(t *testing.T) {
	stream := newNativePacketStream()
	stream.packets <- mt.Pkt{Cmd: &mt.ToCltChatMsg{Text: "hanaworlds_probe_" + testNonce + " = <not set>"}}
	close(stream.packets)
	if _, err := waitForRequest(make(chan requestResult), stream); err == nil {
		t.Fatal("idle text authorized a future request")
	}
}
func TestCommandAdmissionDrainsNativeTraffic(t *testing.T) {
	stream := newNativePacketStream()
	slot := make(chan time.Time, 1)
	cancelled, produced, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(produced)
		for range 256 {
			select {
			case stream.packets <- mt.Pkt{Cmd: &mt.ToCltTimeOfDay{}}:
			case <-cancelled:
				return
			}
		}
		slot <- time.Now()
	}()
	go func() {
		defer close(done)
		if err := waitForCommandSlot(slot, stream); err != nil {
			t.Error(err)
		}
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Error("admission stopped receiving native traffic")
		close(cancelled)
		<-produced
		slot <- time.Now()
		<-done
	}
	<-produced
}
