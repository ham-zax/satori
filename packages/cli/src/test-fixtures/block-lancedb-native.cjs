const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function blockLanceDbNative(request, parent, isMain) {
    if (request === "@lancedb/lancedb" || request.startsWith("@lancedb/lancedb-")) {
        throw new Error("SATORI_TEST_LANCEDB_NATIVE_UNAVAILABLE");
    }
    return originalLoad.call(this, request, parent, isMain);
};
