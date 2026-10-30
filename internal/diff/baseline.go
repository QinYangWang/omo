package diff

// MaxBaselineBytes bounds the pre-agent text one workspace keeps for review.
// Past it, later files are left out of the review rather than growing without
// limit: an agent that rewrites hundreds of megabytes must not be able to
// exhaust the process.
const MaxBaselineBytes int64 = 64 << 20

// maxBaselineFiles bounds the count separately: empty files cost no bytes.
const maxBaselineFiles = 1024

// Base is the text one file had before the agent touched it. NewFile reports
// that the file did not exist then.
type Base struct {
	Rel     string
	Text    string
	NewFile bool
}

// Baseline remembers the text files had before an agent touched them, in the
// order the agent first mentioned them. The first capture of a path wins; later
// ones are ignored, so a file the agent rewrites twice is still reviewed
// against what it was before the agent touched it at all.
type Baseline struct {
	limit int64
	used  int64
	files map[string]Base
	order []string
	full  bool
}

// NewBaseline returns a baseline with the default budget.
func NewBaseline() *Baseline { return NewBaselineLimit(MaxBaselineBytes) }

// NewBaselineLimit returns a baseline with an explicit byte budget.
func NewBaselineLimit(limit int64) *Baseline {
	return &Baseline{limit: limit, files: make(map[string]Base)}
}

// Capture records rel's pre-agent text. It returns false when the file was left
// out: the budget is spent, or Degraded says the baseline is already full.
func (b *Baseline) Capture(rel, text string, newFile bool) bool {
	if _, ok := b.files[rel]; ok {
		return true
	}
	size := int64(len(text))
	if len(b.order) >= maxBaselineFiles || b.used+size > b.limit {
		b.full = true
		return false
	}
	b.used += size
	b.files[rel] = Base{Rel: rel, Text: text, NewFile: newFile}
	b.order = append(b.order, rel)
	return true
}

// Has reports whether rel was captured.
func (b *Baseline) Has(rel string) bool {
	if b == nil {
		return false
	}
	_, ok := b.files[rel]
	return ok
}

// Degraded reports that at least one file was left out of the review.
func (b *Baseline) Degraded() bool { return b != nil && b.full }

// Entries returns the captured files in the order the agent first touched them.
func (b *Baseline) Entries() []Base {
	if b == nil {
		return nil
	}
	out := make([]Base, 0, len(b.order))
	for _, rel := range b.order {
		out = append(out, b.files[rel])
	}
	return out
}

// Bytes is how much pre-agent text is held.
func (b *Baseline) Bytes() int64 {
	if b == nil {
		return 0
	}
	return b.used
}
