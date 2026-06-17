# Navigation Regression Fixtures

These fixtures are Satori golden truth. They prove Satori's navigation contracts
directly and are not competitive eval outputs.

Each concrete fixture should include:

- `source` files for the indexed repo shape.
- `expected_symbols.json` for extractor and registry-level symbol truth.
- `expected_edges.json` for relationship truth.
- `expected_tool_outputs.json` for public-tool contract expectations.

Do not use CMM output as the oracle for these files. CMM adapters can be added
later and must compare against this golden truth, not replace it.
