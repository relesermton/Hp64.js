// compiler_Stack_gjs.go - GopherJS variant of compiler_Stack.go.
// Same subset (Stack + MatchBrackets + Span) compiled to plain .js via the
// GopherJS playground / `gopherjs build`, exporting globalThis.hp64Stack.
//
// NOTE: compiled STANDALONE (single-file command): the playground takes a
// virtual file map with just this file, and `gopherjs build compiler_Stack_gjs.go`
// builds only the listed files — so the duplicate func main next to
// compiler_Stack.go is fine. No build tag: the playground compiler must not
// exclude the file.
//
// JS bridge (globalThis.hp64Stack):
//   matchBrackets(tv: Int32Array) -> { close, open, sd } (Int32Array)
//   newStack(cap) / stackPush / stackPop / stackPeek / stackDepth / stackClear
//   span(openIdx, brackets) -> { start, end } | null
//
// tv codes follow Compiler.js: 0 plain | charCode (1-char punct) |
// 128+i (multi punct) | 256+i (keyword). Brackets: ( 40 ) 41 [ 91 ] 93 { 123 } 125.

package main

import "github.com/gopherjs/gopherjs/js"

// ---------------------------------------------------------------------------
// Stack - fixed-capacity int32 stack (mirrors compiler_stack.js createStack).
// ---------------------------------------------------------------------------

type Stack struct {
	a  []int
	sp int
}

func NewStack(capacity int) *Stack {
	if capacity <= 0 {
		capacity = 4096
	}
	return &Stack{a: make([]int, capacity)}
}

// Push returns false on overflow (JS side maps that to the old throw).
func (s *Stack) Push(v int) bool {
	if s.sp == len(s.a) {
		return false
	}
	s.a[s.sp] = v
	s.sp++
	return true
}

// Pop returns -1 when empty (same as compiler_stack.js).
func (s *Stack) Pop() int {
	if s.sp == 0 {
		return -1
	}
	s.sp--
	return s.a[s.sp]
}

// Peek returns -1 when empty (same as compiler_stack.js).
func (s *Stack) Peek() int {
	if s.sp == 0 {
		return -1
	}
	return s.a[s.sp-1]
}

func (s *Stack) Depth() int { return s.sp }

func (s *Stack) Clear() { s.sp = 0 }

// ---------------------------------------------------------------------------
// MatchBrackets - exact port of Compiler.js bracketMap().
// sd[i] = depth BEFORE the effect; closes do d-- BEFORE the pop, then
// type-checked match; unmatched brackets keep close/open = -1.
// ---------------------------------------------------------------------------

func matchBracketsImpl(tv *js.Object) (closeA, openA, sd *js.Object) {
	n := tv.Length()
	ia := js.Global.Get("Int32Array")
	closeA = ia.New(n)
	openA = ia.New(n)
	sd = ia.New(n)
	for i := 0; i < n; i++ {
		closeA.SetIndex(i, -1)
		openA.SetIndex(i, -1)
	}
	stack := make([]int, n)
	sp, d := 0, 0
	for i := 0; i < n; i++ {
		v := tv.Index(i).Int()
		sd.SetIndex(i, d)
		if v == 40 || v == 91 || v == 123 { // ( [ {
			stack[sp] = i
			sp++
			d++
			continue
		}
		if v == 41 || v == 93 || v == 125 { // ) ] }
			if d > 0 {
				d--
			}
			if sp > 0 {
				sp--
				o := stack[sp]
				ov := tv.Index(o).Int()
				if (v == 41 && ov == 40) || (v == 93 && ov == 91) || (v == 125 && ov == 123) {
					closeA.SetIndex(o, i)
					openA.SetIndex(i, o)
				}
			}
		}
	}
	return closeA, openA, sd
}

// Span: matched span [openIdx, closeIdx] for the bracket at openIdx, or nil.
func spanImpl(openIdx int, brackets *js.Object) *js.Object {
	closeA := brackets.Get("close")
	if openIdx < 0 || openIdx >= closeA.Length() {
		return nil
	}
	c := closeA.Index(openIdx).Int()
	if c < 0 {
		return nil
	}
	obj := js.Global.Get("Object").New()
	obj.Set("start", openIdx)
	obj.Set("end", c)
	return obj
}

// ---------------------------------------------------------------------------
// JS bridge - registry of Go-side stacks keyed by integer id.
// ---------------------------------------------------------------------------

var stacks = []*Stack{}

func stackById(id int) *Stack {
	if id < 0 || id >= len(stacks) {
		return nil
	}
	return stacks[id]
}

func main() {
	hp := js.Global.Get("Object").New()

	hp.Set("matchBrackets", js.MakeFunc(func(this *js.Object, args []*js.Object) any {
		c, o, sd := matchBracketsImpl(args[0])
		obj := js.Global.Get("Object").New()
		obj.Set("close", c)
		obj.Set("open", o)
		obj.Set("sd", sd)
		return obj
	}))

	hp.Set("newStack", js.MakeFunc(func(this *js.Object, args []*js.Object) any {
		capacity := 4096
		if len(args) > 0 {
			capacity = args[0].Int() // undefined/0 -> NewStack default
		}
		stacks = append(stacks, NewStack(capacity))
		return len(stacks) - 1
	}))

	hp.Set("stackPush", js.MakeFunc(func(this *js.Object, args []*js.Object) any {
		s := stackById(args[0].Int())
		if s == nil || !s.Push(args[1].Int()) {
			return 1
		}
		return 0
	}))

	hp.Set("stackPop", js.MakeFunc(func(this *js.Object, args []*js.Object) any {
		s := stackById(args[0].Int())
		if s == nil {
			return -1
		}
		return s.Pop()
	}))

	hp.Set("stackPeek", js.MakeFunc(func(this *js.Object, args []*js.Object) any {
		s := stackById(args[0].Int())
		if s == nil {
			return -1
		}
		return s.Peek()
	}))

	hp.Set("stackDepth", js.MakeFunc(func(this *js.Object, args []*js.Object) any {
		s := stackById(args[0].Int())
		if s == nil {
			return 0
		}
		return s.Depth()
	}))

	hp.Set("stackClear", js.MakeFunc(func(this *js.Object, args []*js.Object) any {
		if s := stackById(args[0].Int()); s != nil {
			s.Clear()
		}
		return nil
	}))

	hp.Set("span", js.MakeFunc(func(this *js.Object, args []*js.Object) any {
		return spanImpl(args[0].Int(), args[1])
	}))

	hp.Set("ready", true)
	js.Global.Set("hp64Stack", hp)
}
