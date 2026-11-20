//go:build js && wasm

// compiler_Stack.go - Go/WASM port of compiler_stack.js (HP64.js).
// Port of the bracket / parse stack primitives:
//   - Stack: fixed-capacity int32 stack (no per-push allocation)
//   - MatchBrackets: pair every bracket token with its match + per-token depth
//   - Span: matched span [openIdx, closeIdx] for the bracket at openIdx
//
// Build:
//   set GOOS=js
//   set GOARCH=wasm
//   go build -o dist\hp64stack.wasm compiler_Stack.go
//
// JS bridge (registered under globalThis.hp64Stack):
//   matchBrackets(tv: Int32Array) -> { close, open, sd } (Int32Array)
//   newStack(cap) / stackPush / stackPop / stackPeek / stackDepth / stackClear
//   span(tv, openIdx, brackets) -> { start, end } | null
//
// tv codes follow Compiler.js: 0 plain | charCode (1-char punct) |
// 128+i (multi punct) | 256+i (keyword). Bracket codes are the 1-char
// charCodes: ( 40 ) 41 [ 91 ] 93 { 123 } 125.

package main

import (
	"syscall/js"
)

// ---------------------------------------------------------------------------
// Stack - fixed-capacity int32 stack, mirroring compiler_stack.js createStack.
// ---------------------------------------------------------------------------

type Stack struct {
	a  []int32
	sp int
}

func NewStack(capacity int) *Stack {
	if capacity <= 0 {
		capacity = 4096
	}
	return &Stack{a: make([]int32, capacity)}
}

func (s *Stack) Push(v int32) error {
	if s.sp == len(s.a) {
		return errStackOverflow
	}
	s.a[s.sp] = v
	s.sp++
	return nil
}

// Pop returns -1 when empty (same as compiler_stack.js).
func (s *Stack) Pop() int32 {
	if s.sp == 0 {
		return -1
	}
	s.sp--
	return s.a[s.sp]
}

// Peek returns -1 when empty (same as compiler_stack.js).
func (s *Stack) Peek() int32 {
	if s.sp == 0 {
		return -1
	}
	return s.a[s.sp-1]
}

func (s *Stack) Depth() int { return s.sp }

func (s *Stack) Clear() { s.sp = 0 }

type overflowError struct{}

func (overflowError) Error() string { return "compiler stack overflow" }

var errStackOverflow = overflowError{}

// ---------------------------------------------------------------------------
// MatchBrackets - exact port of Compiler.js bracketMap().
//
// For every bracket token: sd[i] = depth BEFORE the effect; opens push onto
// the stack and d++; closes do d-- BEFORE the pop, then type-checked match
// (only ( ), [ ], { } pair). Unmatched brackets keep close/open = -1.
// ---------------------------------------------------------------------------

const (
	cLP  = 40  // (
	cRP  = 41  // )
	cLB  = 91  // [
	cRB  = 93  // ]
	cLBR = 123 // {
	cRBR = 125 // }
)

type Brackets struct {
	Close []int32
	Open  []int32
	Sd    []int32
}

// MatchBrackets takes the token tv codes (length = token count, EOF included)
// and returns close/open/sd arrays of the same length, -1 for unmatched.
func MatchBrackets(tv []int32) *Brackets {
	n := len(tv)
	closeA := make([]int32, n)
	openA := make([]int32, n)
	sd := make([]int32, n)
	stack := make([]int32, n)

	for i := 0; i < n; i++ {
		closeA[i] = -1
		openA[i] = -1
	}

	sp := 0
	d := 0
	for i := 0; i < n; i++ {
		v := tv[i]
		sd[i] = int32(d)
		if v == cLP || v == cLB || v == cLBR {
			stack[sp] = int32(i)
			sp++
			d++
			continue
		}
		if v == cRP || v == cRB || v == cRBR {
			if d > 0 {
				d--
			}
			if sp > 0 {
				sp--
				o := stack[sp]
				ov := tv[o]
				if (v == cRP && ov == cLP) ||
					(v == cRB && ov == cLB) ||
					(v == cRBR && ov == cLBR) {
					closeA[o] = int32(i)
					openA[i] = o
				}
			}
		}
	}
	return &Brackets{Close: closeA, Open: openA, Sd: sd}
}

// Span returns the matched span [openIdx, closeIdx] for the bracket at
// openIdx, or nil when unmatched (mirrors compiler_stack.js span()).
func Span(openIdx int32, b *Brackets) (int32, int32, bool) {
	if openIdx < 0 || int(openIdx) >= len(b.Close) {
		return 0, 0, false
	}
	c := b.Close[openIdx]
	if c >= 0 {
		return openIdx, c, true
	}
	return 0, 0, false
}

// ---------------------------------------------------------------------------
// JS bridge - syscall/js exports under globalThis.hp64Stack.
// ---------------------------------------------------------------------------

// i32FromJS copies a JS Int32Array/Uint32Array (or array-like) into []int32.
func i32FromJS(v js.Value) []int32 {
	n := v.Get("length").Int()
	out := make([]int32, n)
	if n == 0 {
		return out
	}
	// Fast path: typed arrays expose a byte-level view we can copy wholesale.
	// Int32Array is little-endian on every wasm target, so a byte copy is a
	// value-preserving copy.
	if v.InstanceOf(js.Global().Get("Int32Array")) ||
		v.InstanceOf(js.Global().Get("Uint32Array")) {
		src := js.Global().Get("Uint8Array").New(v.Get("buffer"), v.Get("byteOffset"), v.Get("byteLength"))
		buf := make([]byte, n*4)
		js.CopyBytesToGo(buf, src)
		for i := 0; i < n; i++ {
			j := i * 4
			out[i] = int32(buf[j]) | int32(buf[j+1])<<8 | int32(buf[j+2])<<16 | int32(buf[j+3])<<24
		}
		return out
	}
	for i := 0; i < n; i++ {
		out[i] = int32(v.Index(i).Int())
	}
	return out
}

// i32ToJS wraps []int32 as a JS Int32Array (copies into wasm-shared memory).
func i32ToJS(a []int32) js.Value {
	out := js.Global().Get("Int32Array").New(len(a))
	if len(a) == 0 {
		return out
	}
	buf := make([]byte, len(a)*4)
	for i, v := range a {
		j := i * 4
		u := uint32(v)
		buf[j] = byte(u)
		buf[j+1] = byte(u >> 8)
		buf[j+2] = byte(u >> 16)
		buf[j+3] = byte(u >> 24)
	}
	js.CopyBytesToJS(out, buf)
	return out
}

// bracketsToJS -> { close, open, sd } as Int32Arrays.
func bracketsToJS(b *Brackets) js.Value {
	obj := js.Global().Get("Object").New()
	obj.Set("close", i32ToJS(b.Close))
	obj.Set("open", i32ToJS(b.Open))
	obj.Set("sd", i32ToJS(b.Sd))
	return obj
}

// keepAlive holds every js.Func so the GC never finalizes a live export.
var keepAlive []js.Func

func reg(name string, fn func(js.Value, []js.Value) interface{}) {
	f := js.FuncOf(fn)
	keepAlive = append(keepAlive, f)
	js.Global().Get("hp64Stack").Set(name, f)
}

func jsObj() js.Value {
	g := js.Global()
	hp := g.Get("hp64Stack")
	if hp.IsUndefined() || hp.IsNull() {
		hp = g.Get("Object").New()
		g.Set("hp64Stack", hp)
	}
	return hp
}

func main() {
	jsObj()

	// matchBrackets(tv) -> { close, open, sd }
	reg("matchBrackets", func(this js.Value, args []js.Value) interface{} {
		tv := i32FromJS(args[0])
		return bracketsToJS(MatchBrackets(tv))
	})

	// newStack(cap) -> Stack handle (opaque js.Value wrapper around a Go ptr
	// stored in a JS object slot). We keep Go-side stacks in a registry so the
	// JS side only ever holds an integer id.
	stacks := []*Stack{}
	reg("newStack", func(this js.Value, args []js.Value) interface{} {
		cap := 4096
		if len(args) > 0 && args[0].Type() == js.TypeNumber {
			cap = args[0].Int()
		}
		stacks = append(stacks, NewStack(cap))
		return len(stacks) - 1
	})
	// stackPush(id, v) -> 0 ok, 1 overflow (mirrors JS throw)
	reg("stackPush", func(this js.Value, args []js.Value) interface{} {
		id := args[0].Int()
		if id < 0 || id >= len(stacks) {
			return 1
		}
		if err := stacks[id].Push(int32(args[1].Int())); err != nil {
			return 1
		}
		return 0
	})
	reg("stackPop", func(this js.Value, args []js.Value) interface{} {
		id := args[0].Int()
		if id < 0 || id >= len(stacks) {
			return -1
		}
		return stacks[id].Pop()
	})
	reg("stackPeek", func(this js.Value, args []js.Value) interface{} {
		id := args[0].Int()
		if id < 0 || id >= len(stacks) {
			return -1
		}
		return stacks[id].Peek()
	})
	reg("stackDepth", func(this js.Value, args []js.Value) interface{} {
		id := args[0].Int()
		if id < 0 || id >= len(stacks) {
			return 0
		}
		return stacks[id].Depth()
	})
	reg("stackClear", func(this js.Value, args []js.Value) interface{} {
		id := args[0].Int()
		if id >= 0 && id < len(stacks) {
			stacks[id].Clear()
		}
		return nil
	})

	// span(tv, openIdx, brackets) -> { start, end } | null
	reg("span", func(this js.Value, args []js.Value) interface{} {
		openIdx := int32(args[1].Int())
		br := args[2]
		b := &Brackets{
			Close: i32FromJS(br.Get("close")),
			Open:  i32FromJS(br.Get("open")),
			Sd:    i32FromJS(br.Get("sd")),
		}
		start, end, ok := Span(openIdx, b)
		if !ok {
			return nil
		}
		obj := js.Global().Get("Object").New()
		obj.Set("start", start)
		obj.Set("end", end)
		return obj
	})

	// ready signal so the JS loader can await instantiation
	js.Global().Get("hp64Stack").Set("ready", true)

	// Block forever (Go runtime must not exit while exports are live).
	select {}
}
