void first_sink() {}
void second_sink() {}
IMPL_LINK(MyClass, FirstHandler, void*, void) { first_sink(); }
IMPL_LINK(MyClass, SecondHandler, void*, void) { second_sink(); }
void FNAME(first_caller)(void) { first_sink(); }
void FNAME(later_function)(void) { second_sink(); }
void Cls::__API_HOOK(Reload)(int slot) { first_sink(); }
void ordinary() { second_sink(); first_caller(); later_function(); Cls::Reload(0); }
int (*pick(int k))(int) { return 0; }
void PAIR(alpha, beta)(void) {}
void WRAP(const Name)(void) {}
void WRAP(proto_only)(void);
