package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	mt "github.com/HimbeerserverDE/mt"
	"github.com/HimbeerserverDE/srp"
	"net"
	"os"
	"strings"
	"time"
)

type Input struct {
	Port               int
	Username, Password string
	Fixture            bool
	Command            string
}

func main() {
	var in Input
	if json.NewDecoder(os.Stdin).Decode(&in) != nil {
		panic("input")
	}
	if in.Fixture {
		s, v, e := srp.NewClient([]byte(strings.ToLower(in.Username)), []byte(in.Password))
		if e != nil {
			panic(e)
		}
		fmt.Print("#1#" + base64.RawStdEncoding.EncodeToString(s) + "#" + base64.RawStdEncoding.EncodeToString(v))
		return
	}
	timer := time.AfterFunc(12*time.Second, func() { fmt.Fprintln(os.Stderr, "TIMEOUT"); os.Exit(3) })
	defer timer.Stop()
	c, e := net.Dial("udp", fmt.Sprintf("127.0.0.1:%d", in.Port))
	if e != nil {
		panic(e)
	}
	p := mt.Connect(c)
	defer p.Close()
	send := func(c mt.Cmd) {
		if _, e := p.SendCmd(c); e != nil {
			panic(e)
		}
	}
	send(&mt.ToSrvNil{})
	send(&mt.ToSrvInit{SerializeVer: 29, MinProtoVer: 53, MaxProtoVer: 53, PlayerName: in.Username})
	var A, a []byte
	auth := false
	ready := false
	for {
		pkt, e := p.Recv()
		if e != nil {
			panic(e)
		}
		switch cmd := pkt.Cmd.(type) {
		case *mt.ToCltHello:
			if cmd.AuthMethods&mt.SRP == 0 {
				fmt.Println("NO_EXISTING_SRP_ACCOUNT")
				return
			}
			A, a, e = srp.InitiateHandshake()
			if e != nil {
				panic(e)
			}
			send(&mt.ToSrvSRPBytesA{A: A, NoSHA1: true})
		case *mt.ToCltSRPBytesSaltB:
			K, e := srp.CompleteHandshake(A, a, []byte(strings.ToLower(in.Username)), []byte(in.Password), cmd.Salt, cmd.B)
			if e != nil {
				panic(e)
			}
			send(&mt.ToSrvSRPBytesM{M: srp.ClientProof([]byte(in.Username), cmd.Salt, A, cmd.B, K)})
		case *mt.ToCltAcceptAuth:
			auth = true
			fmt.Println("NATIVE_SRP_AUTH_ACCEPT")
			send(&mt.ToSrvInit2{Lang: "en"})
		case *mt.ToCltCSMRestrictionFlags:
			if !auth {
				panic("not authenticated")
			}
			if !ready {
				ready = true
				send(&mt.ToSrvCltReady{Major: 5, Minor: 17, Patch: 0, Version: "HanaWorlds authority probe", Formspec: 4})
				send(&mt.ToSrvChatMsg{Msg: in.Command})
			}
		case *mt.ToCltChatMsg:
			b, _ := json.Marshal(map[string]any{"type": cmd.Type, "sender": cmd.Sender, "text": cmd.Text})
			fmt.Println(string(b))
			if strings.Contains(cmd.Text, "HTTP_FIXTURE") || strings.Contains(cmd.Text, "hanaworlds_probe_") || strings.Contains(cmd.Text, "privileges") || strings.Contains(cmd.Text, "Privileges of") {
				return
			}
		case *mt.ToCltKick:
			fmt.Printf("NATIVE_DENIED reason=%d\n", cmd.Reason)
			return
		}
	}
}
