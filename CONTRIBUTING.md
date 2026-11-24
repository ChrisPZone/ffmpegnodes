# Contributing to ffmpegnodes

Bug reports, ideas and pull requests are welcome.

## Reporting bugs and ideas

- Use the issue forms: **Bug report** or **Feature request**.
- For a bug, include the ffmpegnodes version, your OS, the output of `ffmpeg -version` (first line), and the command shown in the *Command* tab. The *Log* tab helps when a run fails.
- Security problems: see [SECURITY.md](SECURITY.md). Please don't open a public issue.

## Setting up

You need Node 20+, pnpm, Rust, and `ffmpeg` / `ffprobe`. The [README](README.md#prerequisites) has the details.

```bash
pnpm install
pnpm tauri dev      # desktop app
pnpm dev            # UI only in a browser, with ffmpeg/ffprobe mocked
```

## Before you open a pull request

```bash
pnpm typecheck
pnpm test
cd src-tauri && cargo test     # when you changed Rust code
```

- For UI changes, check them in the browser preview (`pnpm dev`) and keep the console free of errors.
- Keep each file's line endings: some files are CRLF and some are LF.
- Pure logic (serializer, validation, wizard builder) takes plain `Graph` objects and gets unit tests.
- [CLAUDE.md](CLAUDE.md) lists the architecture rules and conventions. If your change adds or alters one, update it in the same pull request.
- UI text is short and plain. The project name is always written `ffmpegnodes`.

## Pull requests

- One topic per pull request, with a short description of what changed and why.
- The *Test* workflow runs typecheck and the tests on every pull request.
- By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
