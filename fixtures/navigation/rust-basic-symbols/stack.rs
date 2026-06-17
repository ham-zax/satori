pub struct Stack<T> { items: Vec<T> }

impl<T> Stack<T> {
    pub fn new() -> Self { Stack { items: Vec::new() } }
    fn push(&mut self, item: T) { self.items.push(item); }
}

pub trait Store { fn save(&self); }
mod inner { pub fn nested() {} }
fn demo() {}
