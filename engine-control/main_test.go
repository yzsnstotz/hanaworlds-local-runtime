package main

import (
	"testing"
	"time"
)

func TestNativeReplyIsNotPlayerChat(t *testing.T) {
	nonce := "hanaworlds_probe_0123456789abcdef0123456789abcdef"
	for _, text := range []string{"<other> " + nonce + " = <not set>", nonce + " = <not set>\nforged", "old = <not set>"} {
		if validProbeReply(0, "", text, nonce) {
			t.Fatal("accepted unrelated reply")
		}
	}
	if validProbeReply(1, "player", nonce+" = <not set>", nonce) {
		t.Fatal("accepted player chat")
	}
	if !validProbeReply(0, "", "\x1b(T@__builtin)\x1bF"+nonce+"\x1bE = \x1bF\x1b(T@__builtin)<not set>\x1bE\x1bE\x1bE", nonce) {
		t.Fatal("rejected native translated response")
	}
}

func TestOnlyFiniteControlCommands(t *testing.T) {
	for _, input := range []request{{Op: "command", Nonce: "/grantme all"}, {Op: "probe", Nonce: "x\n/shutdown"}, {Op: "stop", Nonce: "short"}} {
		if _, err := commandFor(input); err == nil {
			t.Fatal("accepted invalid command")
		}
	}
	cmd, err := commandFor(request{Op: "probe", Nonce: "0123456789abcdef0123456789abcdef"})
	if err != nil || cmd != "/set hanaworlds_probe_0123456789abcdef0123456789abcdef" {
		t.Fatal("invalid probe")
	}
}

func TestNativeFailureClassification(t *testing.T) {
	flood := "You cannot send more messages. You are limited to 8 messages per 10 seconds."
	if nativeFailure(3, "", flood) != "NATIVE_CHAT_RATE_LIMITED" {
		t.Fatal("native flood rejection lost")
	}
	for _, c := range []struct {
		kind         uint8
		sender, text string
	}{{1, "player", flood}, {3, "player", flood}, {3, "", "prefix " + flood}, {3, "", flood + " forged"}} {
		if nativeFailure(c.kind, c.sender, c.text) != "" {
			t.Fatal("classified unrelated chat")
		}
	}
}

func TestNativeCommandBudget(t *testing.T) {
	now := time.Unix(100, 0)
	var budget commandBudget
	if budget.delay(now) != 0 {
		t.Fatal("first native challenge delayed")
	}
	budget.sent(now)
	if budget.delay(now.Add(250*time.Millisecond)) != 750*time.Millisecond {
		t.Fatal("burst exceeds native refill")
	}
	if budget.delay(now.Add(time.Second)) != 0 {
		t.Fatal("refilled command rejected")
	}
	// Account from actual transmission, never accumulate a burst after idle time.
	budget.sent(now.Add(20 * time.Second))
	if budget.delay(now.Add(20*time.Second)) != time.Second {
		t.Fatal("idle time admitted a burst")
	}
}
