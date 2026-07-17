# AGENTS.md - Developer Guidelines for Micro Chess

## Overview
Micro Chess is a lightweight, AI-generated chess platform with PWA support. It uses vanilla HTML/CSS/JS with a focus on performance for slow networks and e-ink devices (Kindle).

---

## Build Commands

### Installation
```bash
npm install
```

### Development
```bash
npm run dev    # Watch mode with live reload (esbuild)
```

### Production Build
```bash
npm run build  # Minify and bundle JS
# Output: public/bundle.js
```

### Testing
```bash
npm test       # Placeholder - no real tests configured
```

---

## Project Structure

```
micro_chess/
├── index.html              # Homepage
├── chess.html              # Unified game page (future)
├── over_the_board.html     # PvP mode (current)
├── stockfish.html          # AI mode (current)
├── about.html              # About page
├── style.css               # Main styles
├── style_kindle.css        # E-ink optimized styles
├── sw.js                   # Service Worker (PWA)
├── public/                 # Build output
│   ├── app.js              # Entry point (JS)
│   └── bundle.js           # Bundled output
├── src/                    # TypeScript source (future)
│   ├── game.ts
│   ├── stockfish.ts
│   ├── state.ts
│   ├── ui.ts
│   └── config.ts
├── js/                     # JavaScript modules
│   └── supabase_client.js
├── Legacy/                 # Deprecated pages
└── supabase/               # Backend functions
```

---

## Code Style Guidelines

### General Principles
- Keep code minimal and readable
- Prioritize performance for slow networks
- No unnecessary comments - code should be self-documenting
- Use ES6+ features (const/let, arrow functions, template literals)

### Naming Conventions
- **Variables/functions**: camelCase (`selectedSquare`, `renderBoard()`)
- **Constants**: UPPER_SNAKE_CASE (`MAX_DEPTH`, `CDN_URLS`)
- **Classes**: PascalCase (`GameManager`, `ChessEngine`)
- **File names**: kebab-case (`game-logic.ts`, `stockfish-ai.ts`)
- **HTML IDs**: snake_case (`game_over_overlay`, `promotion_dialog`)

### TypeScript Conventions (when using .ts files)

```typescript
// Interfaces
interface GameState {
    selectedSquare: string | null;
    validMoves: string[];
    gameMode: 'otb' | 'stockfish';
}

// Types
type Square = 'a1' | 'a2' | ... | 'h8';
type PieceColor = 'w' | 'b';
type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

// Function signatures
function renderBoard(state: GameState): void;
function handleSquareClick(square: Square): void;
```

### Imports (ES Modules)

```typescript
// CDN imports - keep as-is for esbuild to handle
import { Chess } from 'https://unpkg.com/chess.js@1.0.0-beta.8/dist/esm/chess.js';

// Local imports
import { GameState } from './state.js';
import { renderBoard } from './ui.js';
```

### Error Handling

```typescript
// Prefer early returns over deep nesting
function initGame(): void {
    const board = document.getElementById('board');
    if (!board) {
        console.error('Board element not found');
        return;
    }
    // ... rest of code
}

// Use try-catch for async operations
async function loadStockfish(): Promise<void> {
    try {
        const response = await fetch(STOCKFISH_CDN);
        // ...
    } catch (error) {
        console.error('Failed to load Stockfish:', error);
    }
}
```

### DOM Manipulation

```typescript
// Cache DOM elements
const board = document.getElementById('board');
const statusEl = document.getElementById('status');

// Check existence before use
if (!board) return;

// Use classList for toggling
element.classList.add('selected');
element.classList.remove('valid-move');
element.classList.toggle('show');
```

### Game Logic

```typescript
// Use chess.js for move validation
import { Chess } from 'https://unpkg.com/chess.js@1.0.0-beta.8/dist/esm/chess.js';

const game = new Chess();

// Validate moves
const moves = game.moves({ square: 'e2', verbose: true });
const move = game.move({ from: 'e2', to: 'e4', promotion: 'q' });

// Check game state
if (game.in_checkmate()) { /* ... */ }
if (game.in_draw()) { /* ... */ }
```

---

## HTML Guidelines

### Meta Tags (keep on all pages)
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#22c55e">
<meta name="google-site-verification" content="0xOMwKR3f4Yp5CE543fQ29XkV8N-bpCC8yI622ag3yU" />
```

### Script Loading
- Put scripts at end of body
- Use `defer` attribute if moving to head
- Keep CDN libs: chess.js, supabase-js, stockfish.js

### Accessibility
- Use semantic HTML (nav, main, section)
- Add alt text to piece images
- Ensure keyboard navigation works

---

## CSS Guidelines

### Structure
- Keep in single `style.css` (minimize HTTP requests)
- Use CSS variables for colors
- Mobile-first responsive design

```css
:root {
    --primary: #22c55e;
    --dark: #1f2937;
    --light: #f3f4f6;
}

.square.light { background: #f0d9b5; }
.square.dark { background: #b58863; }
```

### Performance
- Avoid complex selectors
- Use transform for animations (GPU accelerated)
- Minimize reflows - batch DOM updates

---

## Netlify Deployment

### _redirects File
```
/                    /index.html   200
/chess/otb          /chess.html  200
/chess/stockfish     /chess.html  200
```

### Service Worker Strategy
- Cache-first for static assets
- Network-first for API calls
- Cache CDN libraries on first load

---

## Common Tasks

### Adding a New Feature
1. Create/modify source in appropriate file
2. Run `npm run build` to bundle
3. Test in browser
4. Update service worker if caching needed

### Fixing a Bug
1. Identify the relevant HTML file
2. Find the inline script or external JS
3. Make fix
4. If in public/app.js, rebuild: `npm run build`

### Building for Production
```bash
npm run build
# Deploy public/ folder to Netlify
```

---

## Performance Targets
- Initial load: < 100KB (excluding cached CDN)
- First paint: < 1 second on 3G
- Offline support: Full functionality after first load

---

## Resources
- [chess.js docs](https://github.com/jhlywa/chess.js)
- [esbuild docs](https://esbuild.github.io/)
- [Stockfish.js](https://github.com/nmrugg/stockfish.js/)
