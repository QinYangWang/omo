# omo (oh-my-openagents)

omo 是 Pi Agent 的 Electron Desktop 与 Web 客户端。项目使用 Electron、React 19、Vite、Tailwind CSS v4、shadcn/ui（Base UI）、React Virtuoso、React Markdown，以及 in-process 的 `@earendil-works/pi-coding-agent` SDK。

## 运行

```bash
npm install
npm run dev          # Vite 5188 + Electron
npm run build        # tsc -b && vite build
npm start            # Electron
npm run server       # omo Server，默认 127.0.0.1:5189
npm run server:dev   # omo Server watch 模式
```

## 核心约束

- 业务组件统一通过 `src/lib/omo.ts` 访问后端，不要直接新增 `window.omo` 调用。
- `components.json` 使用 `base-rhea`，UI 底层组件为 Base UI；自定义 trigger 使用 `render` prop。
- Pi Agent 在本地 Electron 主进程或 omo Server 进程内运行，不使用 RPC 子进程。
- Server 的 Project、Agent、文件、Git 和终端路径必须位于 `OMO_WORKSPACE_ROOTS` 内。
- 组件颜色使用语义化 CSS 变量。

## 文档索引

- [docs/architecture.md](docs/architecture.md) — 运行形态、代码边界、本地与远程数据流
- [docs/client-modes.md](docs/client-modes.md) — Electron 本地/远程、静态 Web、safeStorage 与连接配置
- [docs/server.md](docs/server.md) — omo Server 启动、配置、托管与 Docker
- [docs/server-api.md](docs/server-api.md) — HTTP、SSE 和 WebSocket API 参考
- [docs/reliability.md](docs/reliability.md) — SQLite 事件、SSE 重放、Prompt 幂等与终端恢复
- [docs/security.md](docs/security.md) — Token、workspace、Session path、WebSocket ticket 与凭据边界
- [docs/sessions.md](docs/sessions.md) — Pi Session 生命周期、Turn 聚合、RenderBlock 适配、虚拟列表与实时同步边界
- [docs/terminal.md](docs/terminal.md) — 本地 shell 与远程 PTY、缓冲、重连和回收
- [docs/providers-usage.md](docs/providers-usage.md) — Provider 认证、配额和 Token 用量
- [docs/ui.md](docs/ui.md) — UI 组件约定、三列布局、代码块、会话大纲与 surface
- [docs/layout.md](docs/layout.md) — 当前页面布局结构
- [docs/deployment-testing.md](docs/deployment-testing.md) — 构建、已实现验证、Docker 和数据卷


# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `npm exec -- ultracite fix`
- **Check for issues**: `npm exec -- ultracite check`
- **Diagnose setup**: `npm exec -- ultracite doctor`

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `npm exec -- ultracite fix` before committing to ensure compliance.
