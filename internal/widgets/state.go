package widgets

import mygoui "github.com/egoist/mygo/ui"

type State struct {
	values map[string]*string
	lists  map[string]*mygoui.ListState
}

func NewState() *State {
	return &State{values: map[string]*string{}, lists: map[string]*mygoui.ListState{}}
}

func (s *State) String(key string) *string {
	value := s.values[key]
	if value == nil {
		value = new(string)
		s.values[key] = value
	}
	return value
}

func (s *State) List(key string) *mygoui.ListState {
	list := s.lists[key]
	if list == nil {
		list = &mygoui.ListState{}
		s.lists[key] = list
	}
	return list
}
