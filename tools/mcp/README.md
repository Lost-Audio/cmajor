# Cmajor Feather MCP Dev Loop

This directory contains a stdio MCP server for driving the local Cmajor command-line tool from Claude Code.

## Tools

- `compile_check { patchPath }`: runs `cmaj play --dry-run --stop-on-error` for `.cmajorpatch` files, or `cmaj generate --target=syntaxtree` for bare `.cmajor` files, and returns parsed diagnostics.
- `patch_info { patchPath }`: statically reads a `.cmajorpatch` manifest and Cmajor source declarations, returning manifest summary, endpoints, and host-style parameters.
- `render_wav { patchPath, outputWav, lengthFrames, rate, inputWav?, midiFile? }`: runs `cmaj render --output --length --rate` with optional `--input` and `--midi`.
- `run_tests { testFileOrDir }`: runs `cmaj test` and parses pass/fail/disabled/unsupported counts plus failure lines.
- `create_patch { folder, name, ui? }`: runs `cmaj create --name`. The current CLI implementation has no UI scaffold flag, so `ui` is accepted but reported as a warning when true.

The server locates `cmaj` from `CMAJ_BIN`. If unset, it falls back to:

```text
F:/Programming/DSP_Projects/2025/cmajor-feather/build/tools/command/Release/cmaj.exe
```

Default command timeout is 60 seconds. `render_wav` uses 300 seconds.

## Build

From this folder:

```sh
pnpm install
pnpm build
```

No dependencies are vendored here. The package pins `@modelcontextprotocol/sdk`, `typescript`, and `@types/node` in `package.json`.

## Claude Code Registration

After building, register the stdio server in Claude Code with the absolute path to the built entrypoint:

```sh
claude mcp add cmajor-feather --env CMAJ_BIN="F:/Programming/DSP_Projects/2025/cmajor-feather/build/tools/command/Release/cmaj.exe" -- node "F:/Programming/DSP_Projects/2025/cmajor-feather-mcp/tools/mcp/dist/index.js"
```

If `cmaj.exe` is already at the fallback path, `--env CMAJ_BIN=...` is optional. If your build output is elsewhere, set `CMAJ_BIN` to that executable.

For a JSON MCP configuration, the equivalent shape is:

```json
{
  "mcpServers": {
    "cmajor-feather": {
      "command": "node",
      "args": [
        "F:/Programming/DSP_Projects/2025/cmajor-feather-mcp/tools/mcp/dist/index.js"
      ],
      "env": {
        "CMAJ_BIN": "F:/Programming/DSP_Projects/2025/cmajor-feather/build/tools/command/Release/cmaj.exe"
      }
    }
  }
}
```

## Notes

`patch_info` intentionally does not claim compiler-resolved endpoint truth. It reads manifest/source text defensively and includes a note in its response. Run `compile_check` alongside it when validating generated patches.
