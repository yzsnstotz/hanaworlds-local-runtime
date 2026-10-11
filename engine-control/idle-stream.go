package main

import (
	"errors"
	mt "github.com/HimbeerserverDE/mt"
	"time"
)

type requestResult struct {
	value request
	err   error
}

// Normal world traffic must keep flowing even when the Host has no command.
// Idle packets never establish current permission; native rejection is terminal.
func idlePacket(packet mt.Pkt, open bool) error {
	if !open {
		return errors.New("CHANNEL_CLOSED")
	}
	switch message := packet.Cmd.(type) {
	case *mt.ToCltKick:
		return errors.New("CHANNEL_CLOSED")
	case *mt.ToCltChatMsg:
		if code := nativeFailure(uint8(message.Type), message.Sender, message.Text); code != "" {
			return errors.New(code)
		}
	}
	return nil
}
func waitForRequest(requests <-chan requestResult, stream *nativePacketStream) (request, error) {
	for {
		select {
		case next := <-requests:
			return next.value, next.err
		case packet, open := <-stream.packets:
			if err := idlePacket(packet, open); err != nil {
				return request{}, err
			}
		}
	}
}
func waitForCommandSlot(slot <-chan time.Time, stream *nativePacketStream) error {
	for {
		select {
		case <-slot:
			return nil
		case packet, open := <-stream.packets:
			if err := idlePacket(packet, open); err != nil {
				return err
			}
		}
	}
}
