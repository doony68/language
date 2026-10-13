# Clean View

A Claude Code mod that makes Claude feel calm for people who aren't technical.
While Claude works, tool calls, diffs and command output are hidden, and one
checklist above the prompt shows the plan, what's happening now and how far along it is.

## Install

In a Claude Code terminal session:

```
/plugin install clean-view --marketplace doony68/language
```

Answer `y` to add the marketplace, then pick the user scope.

## Use

- Clean View starts **on**.
- Click the `● Clean View: ON` button at the right of the header row, or type
  `/simple off` / `/simple on` (`/simple` alone flips it). The choice is remembered after a restart.
- When it is off, every hidden row comes back and only the button stays.

## Develop

- `claude plugin validate clean-view`
- `claude plugin test clean-view`
