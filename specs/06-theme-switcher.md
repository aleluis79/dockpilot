# SPEC-06: Temas Claro, Oscuro y del Sistema

## 1. Contexto y Objetivos
- **Problema**: DockPilot está codificado con una única paleta oscura. Las clases de color están escritas de forma literal y dispersa por los componentes (`bg-zinc-950`, `text-zinc-400`, `border-zinc-800`...), sin ninguna abstracción de tema. Esto tiene dos consecuencias: (a) el panel resulta agotador en entornos con iluminación fuerte o durante sesiones nocturnas prolongadas, y (b) cualquier ajuste de contraste exige editar cientos de clases a mano, lo que hace que el tema sea inacotable en la práctica. Un gestor de Docker se usa con frecuencia en sesiones largas y en horas de productividad diurna, por lo que un tema claro no es un lujo cosmético.
- **Objetivo**: Introducir un sistema de temas con tres modos seleccionables por el usuario —**Oscuro** (comportamiento actual, por defecto), **Claro** y **Sistema** (seguimiento automático de la preferencia del SO) — implementado mediante tokens semánticos de color en Tailwind v4, persistido en `localStorage` y aplicado sin parpadeo al cargar la página. El cambio de tema debe ser instantáneo, no requerir recargar, y aplicarse de forma consistente a toda la interfaz, incluidas las superficies que no son HTML (la terminal embebida de xterm.js y las barras de desplazamiento).
- **Alcance**:
  - Incluye:
    - Tokens semánticos de color (`bg-base`, `bg-surface`, `text-fg`, `border-default`...) definidos en `src/index.css` mediante `@theme inline` + `@custom-variant dark` de Tailwind v4.
    - Migración de los **354 usos de la paleta `zinc`** (superficies, textos y bordes neutros) hacia tokens semánticos, en los 15 componentes que los usan.
    - Ajuste de contraste de los **13 usos de `text-{accent}-200/300`** en modo claro mediante variantes `dark:`.
    - Hook `useTheme` con persistencia, resolución de `matchMedia('(prefers-color-scheme: dark)')` y suscripción a sus cambios.
    - Componente `ThemeToggle` (control segmentado con iconos `Sun` / `Moon` / `Monitor` de `lucide-react`) integrado en la `Navbar`.
    - Paleta clara del tema de xterm.js en `TerminalViewer.tsx` conmutada en caliente.
    - Barras de desplazamiento derivadas de tokens en lugar de hexadecimales fijos.
    - Script anti-parpadeo (anti-FOUC) en `index.html`.
  - No incluye (en esta spec):
    - **Cambios en el backend.** El tema es exclusivamente una cuestión de presentación; no se añaden endpoints, schemas ni campos de configuración en FastAPI. La persistencia es `localStorage` del navegador, no servidor.
    - Personalización fina por el usuario (elegir colores hexadecimales, temas personalizados, contraste alto manual).
    - Exportar/importar la configuración de DockPilot.
    - Tema para la CLI ni para la documentación.

---

## 2. Contrato de Datos (Types & Tokens)

### 2.1 Frontend (TypeScript) - `src/types/theme.ts`
```typescript
export type ThemeMode = 'dark' | 'light' | 'system';

export type ResolvedTheme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'dockpilot-theme';

export const THEME_OPTIONS: ReadonlyArray<{
  mode: ThemeMode;
  label: string;
  icon: 'sun' | 'moon' | 'monitor';
}>;
```

### 2.2 Tokens de color - `src/index.css`

Se declaran tokens semánticos como primitivas del tema. El valor por defecto (declarado en `:root`) corresponde al **tema oscuro** actual, de modo que la aplicación no cambie de aspecto si el JavaScript no llega a ejecutarse.

```css
@import "tailwindcss";

/* Estrategia de variante por clase, no por preferencia del SO:
   el modo "system" se resuelve en JS y se refleja en <html class="dark"> */
@custom-variant dark (&:where(.dark, .dark *));

/* `inline` es obligatorio: hace que las utilidades referencien la variable
   en tiempo de ejecución en lugar de copiar su valor, que es lo que permite
   conmutar el tema sin regenerar las hojas de estilo. Los modificadores de
   opacidad (bg-surface/40) se resuelven vía color-mix() y siguen funcionando. */
@theme inline {
  --color-base: var(--dp-base);
  --color-surface: var(--dp-surface);
  --color-elevated: var(--dp-elevated);
  --color-inset: var(--dp-inset);
  --color-fg: var(--dp-fg);
  --color-fg-muted: var(--dp-fg-muted);
  --color-fg-subtle: var(--dp-fg-subtle);
  --color-border: var(--dp-border);
  --color-border-strong: var(--dp-border-strong);
}

:root {
  --dp-base: #09090b;            /* zinc-950 */
  --dp-surface: #18181b;         /* zinc-900 */
  --dp-elevated: #27272a;        /* zinc-800 */
  --dp-inset: #09090b;           /* zinc-950 */
  --dp-fg: #f4f4f5;              /* zinc-100 */
  --dp-fg-muted: #a1a1aa;        /* zinc-400 */
  --dp-fg-subtle: #71717a;       /* zinc-600 */
  --dp-border: #27272a;          /* zinc-800 */
  --dp-border-strong: #3f3f46;   /* zinc-700 */
}

.dark {
  /* idéntico a :root — se declara explícitamente para que la clase
     sea autosuficiente y el contrato sea legible desde el CSS */
}
```

En modo claro, `html:not(.dark)` sobrescribe los mismos tokens con la paleta zinc clara. La aplicación **no** añade la clase `light`: el tema efectivo es "claro" exactamente cuando `dark` está ausente, lo que evita tener dos clases que mantener sincronizadas.

### 2.3 Mapa de tokens (contrato de migración)

Cada token sustituye a un conjunto concreto de clases existentes. La tabla es normativa: tras la migración no debe quedar ninguna clase de la columna "Clases reemplazadas".

| Token | Oscuro | Claro | Clases reemplazadas |
| :--- | :--- | :--- | :--- |
| `bg-base` | `#09090b` | `#ffffff` | `bg-zinc-950` (fondo de página en `App.tsx`) |
| `bg-surface` | `#18181b` | `#fafafa` | `bg-zinc-900`, `bg-zinc-900/40`, `/50`, `/80`, `/90` |
| `bg-elevated` | `#27272a` | `#f4f4f5` | `bg-zinc-800`, `bg-zinc-800/40`, `/60`, `/80` |
| `bg-inset` | `#09090b` | `#f4f4f5` | `bg-zinc-950/60`, `/70`, `hover:bg-zinc-800/40` (código, logs, terminal) |
| `text-fg` | `#f4f4f5` | `#18181b` | `text-zinc-100`, `text-zinc-200`, `text-zinc-300` |
| `text-fg-muted` | `#a1a1aa` | `#52525b` | `text-zinc-400`, `text-zinc-500` |
| `text-fg-subtle` | `#71717a` | `#a1a1aa` | `text-zinc-600` |
| `border-default` | `#27272a` | `#e4e4e7` | `border-zinc-800`, `border-zinc-800/80` |
| `border-strong` | `#3f3f46` | `#d4d4d8` | `border-zinc-700`, `border-zinc-700/50`, `border-zinc-600` |

**Deliberadamente fuera del sistema de tokens:** la barra lateral de acentos `hover:`/focus se mantiene con la variante `dark:` de Tailwind en vez de tokenizarse, para no multiplicar el número de tokens.

### 2.4 Contrato con Tailwind

- No se crea `tailwind.config.js`. Tailwind v4 con `@tailwindcss/vite` se configura desde CSS.
- `@custom-variant dark` sustituye a la estrategia por defecto (`prefers-color-scheme`), que quedaría obsoleta en cuanto el usuario elija un modo explícito.
- El contenedor raíz `div` de `src/App.tsx:47` deja de fijar `bg-zinc-950 text-zinc-100` y pasa a usar `bg-base text-fg`; la clase `dark` se aplica a `document.documentElement`.

---

## 3. Mecánica del Sistema de Temas

### 3.1 Resolución del tema efectivo

```text
modo almacenado (por defecto: "system")
        │
        ├─ "dark"  ─────────────────────────────► tema efectivo = dark
        ├─ "light" ─────────────────────────────► tema efectivo = light
        └─ "system" ──► matchMedia("(prefers-color-scheme: dark)").matches
                          │
                          ├─ true  ─► tema efectivo = dark
                          └─ false ─► tema efectivo = light
```

Aplicación: `document.documentElement.classList.toggle('dark', efectivo === 'dark')` y `setAttribute('data-theme', modo)`.

### 3.2 Persistencia

- Clave `localStorage`: `dockpilot-theme`. Valores admitidos: `dark`, `light`, `system`.
- Un valor ausente, vacío o no reconocido se trata como `system` (degradación segura: el tema efectivo lo decide el SO).
- Todo acceso a `localStorage` va protegido contra excepciones, para no romper el render en modo privado de algunos navegadores.

### 3.3 Anti-parpadeo (anti-FOUC)

Se inserta un script **síncrono y no diferido** en `<head>`, antes del bundle de Vite, que aplica la clase `dark` leyendo `localStorage`. Sin él, la aplicación pintaría primero el tema oscuro por defecto y luego saltaría al persistido en el primer render de React.

```html
<script>
  (function () {
    try {
      var m = localStorage.getItem('dockpilot-theme') || 'system';
      if (m !== 'light' && m !== 'dark') {
        m = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      if (m === 'dark') document.documentElement.classList.add('dark');
    } catch (e) {}
  })();
</script>
```

### 3.4 Seguimiento del modo "Sistema"

Mientras el modo activo sea `system`, el hook mantiene una suscripción al evento `change` de la MediaQueryList y actualiza el tema efectivo cuando el SO cambia de apariencia (por ejemplo, el cambio automático día/noche de macOS o Windows). Al salir de `system` la suscripción se descarta, de modo que el cambio de apariencia del SO deja de afectar a la interfaz.

### 3.5 Integración con xterm.js (superficie no HTML)

xterm.js no lee clases CSS: su paleta ANSI es un objeto JavaScript. `TerminalViewer.tsx` recibe el tema resuelto y reconstruye sus 19 claves (`background`, `foreground`, `cursor`, `cursorAccent`, `selectionBackground` y las 16 ANSI) en modo claro, con la misma estructura que la actual para evitar condicionales dispersos.

Además, en modo claro la superficie de la terminal debe seguir siendo legible: el `TerminalModal` usa `bg-inset`, que pasa de `#09090b` a `#f4f4f5`.

### 3.6 Barras de desplazamiento

`index.css` fija hoy `#09090b` / `#27272a` / `#3f3f46`. Pasan a leerse de los tokens (`--dp-base`, `--dp-elevated`, `--dp-border-strong`) con un bloque de sobre-escritura en modo claro.

### 3.7 Superficie de usuario

`ThemeToggle` es un **único botón que rota entre los tres modos**, situado en la `Navbar` a la izquierda del indicador de conexión.

- **Ciclo**: `system` → `light` → `dark` → `system`. Cada pulsación avanza un paso; no es posible saltar a un modo concreto, por lo que el estado actual debe ser legible en el propio botón.
- **Icono**: se muestra el icono del modo **actual** (`Monitor` / `Sun` / `Moon` de `lucide-react`), no el siguiente.
- **Animación**: los tres iconos coexisten apilados en un contenedor de tamaño fijo. El activo se ve a opacidad 1 y sin rotación; los inactivos, a opacidad 0 y rotados -90°. La transición CSS produce un giro con fundido al cambiar de modo, sin recrear el nodo (evita parpadeo).
- **Centrado**: los iconos deben ocupar exactamente la caja del contenedor (`absolute inset-0 h-full w-full`). Es obligatorio: los SVG de `lucide-react` declaran `width`/`height` en 24 como atributo de presentación, y sin `h-full w-full` ese ancho explícito prevalence sobre `right: 0`, anclando el icono en la esquina superior izquierda y desbordando la caja de 16px.
- **Accesibilidad**: al ser un único botón se pierde el `aria-pressed` por modo. Se compensa con un `aria-label` que declara **estado actual y siguiente** (p. ej. `Tema: Claro. Cambiar a Oscuro`), un `title` equivalente y `aria-live="polite"` para que el cambio de estado se anuncie. El orden del ciclo se documenta para que sea predecible.
- **Movimiento reducido**: si el usuario tiene `prefers-reduced-motion: reduce`, las transiciones se desactivan con la variante `motion-reduce:` y el cambio es instantáneo.
- **Contraste del botón**: hereda `text-fg-muted` / `hover:text-fg` para no competir visualmente con el resto de la barra.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Temas claro, oscuro y del sistema
  Como desarrollador de software
  Quiero elegir la apariencia del panel de DockPilot
  Para trabajar cómodamente de día o de noche sin que la interfaz meean los ojos

  Antecedentes:
    Dado que el cliente frontend de DockPilot está en ejecución
    Y el usuario no ha configurado ningún tema previamente

  Escenario: Tema oscuro por defecto en ausencia de preferencia
    Dado que no existe la clave "dockpilot-theme" en el almacenamiento local
    Cuando el usuario carga la aplicación
    Entonces el modo de tema activo es "system"
    Y si el sistema operativo reporta preferencia oscura, el tema efectivo es "dark"
    Y el elemento "<html>" tiene la clase "dark"
    Y el atributo "data-theme" vale "system"

  Escenario: Rotación del selector de tema hasta el modo claro
    Dado que el modo de tema activo es "system"
    Cuando el usuario pulsa una vez el botón de tema de la barra de navegación
    Entonces el modo activo avanza a "light"
    Y el elemento "<html>" deja de tener la clase "dark"
    Y el atributo "data-theme" vale "light"
    Y el fondo de la página se muestra en color claro
    Y el icono del botón rota del símbolo de sistema al de sol
    Y el valor "light" se persiste en la clave "dockpilot-theme"

  Escenario: Rotación del selector hasta el modo oscuro y vuelta al sistema
    Dado que el modo de tema activo es "light"
    Cuando el usuario pulsa dos veces consecutivas el botón de tema
    Entonces el modo activo avanza primero a "dark" y después a "system"
    Y el atributo "data-theme" vuelve a valer "system"
    Y el icono del botón completa el ciclo de vuelta al símbolo de sistema
    Entonces el elemento "<html>" recupera la clase "dark"
    Y el atributo "data-theme" vale "dark"
    Y el valor "dark" se persiste en la clave "dockpilot-theme"

  Escenario: Persistencia de la preferencia entre recargas
    Dado que el usuario seleccionó previamente el modo "light"
    Cuando el usuario recarga la página
    Entonces el tema efectivo sigue siendo claro
    Y no se produce ningún parpadeo de tema durante la carga

  Escenario: Seguimiento automático de la preferencia del sistema operativo
    Dado que el modo de tema activo es "system"
    Y la preferencia del sistema operativo cambia de clara a oscura
    Cuando el navegador emite el evento de cambio de la media query
    Entonces el tema efectivo pasa a "dark" sin necesidad de recargar la página
    Y el atributo "data-theme" permanece en "system"

  Escenario: El modo manual ignora los cambios de apariencia del sistema
    Dado que el usuario seleccionó el modo "dark" de forma manual
    Y la preferencia del sistema operativo cambia a clara
    Cuando el navegador emite el evento de cambio de la media query
    Entonces el tema efectivo permanece en "dark"

  Escenario: Valor de tema corrupto o ausente
    Dado que la clave "dockpilot-theme" contiene un valor no reconocido como "neon"
    Cuando el usuario carga la aplicación
    Entonces el sistema degrada de forma segura al modo "system"
    Y la aplicación renderiza correctamente sin lanzar excepciones

  Escenario: Consistencia en las superficies no HTML
    Dado que el usuario tiene abierta la terminal embebida de un contenedor
    Cuando el usuario cambia el tema
    Entonces la terminal actualiza su paleta de colores inmediatamente
    Y el texto de la terminal mantiene contraste legible en ambos temas
    Y las barras de desplazamiento de la página adoptan los colores del tema activo
```

---

## 5. Plan de Pruebas Automatizadas

### Backend
- **No aplica.** Esta spec no introduce cambios en FastAPI, `aiodocker` ni los schemas Pydantic, conforme a la sección de alcance.

### Frontend (`vitest` + `@testing-library/react` + `jsdom`)
- `tests/hooks/useTheme.test.tsx`:
  - `test_theme_defaults_to_system`: sin `localStorage`, el modo inicial es `system` y se resuelve según `matchMedia`.
  - `test_theme_applies_dark_class_on_document_element`: comprueba el `classList` de `documentElement` y el atributo `data-theme`.
  - `test_set_theme_persists_to_local_storage`: `setTheme('light')` deja `"light"` en la clave acordada.
  - `test_theme_follows_system_changes`: se dispara el listener de `matchMedia` y el tema efectivo cambia a `dark` sin recargar.
  - `test_manual_mode_ignores_system_changes`: con modo `dark`, el listener del SO no altera el tema.
  - `test_invalid_stored_value_falls_back_to_system`: un valor corrupto degrada a `system` sin lanzar.
  - `test_local_storage_failure_is_tolerated`: `localStorage` que lanza excepción no impide el render.
- `tests/components/ThemeToggle.test.tsx`:
  - Renderizado de un **único** botón (no tres) con `aria-label` que declara estado actual y siguiente.
  - El icono visible corresponde al modo activo, no al siguiente.
  - Al pulsar, el modo avanza en el orden `system` → `light` → `dark` → `system` y el `aria-label` se actualiza.
  - Con `prefers-reduced-motion: reduce` las clases `motion-reduce:transition-none` están presentes en los iconos.
- Test de arquitectura (regresión) en `tests/theme-tokens.test.ts`:
  - Recorre `src/**/*.tsx` con `node:fs` y falla si aparece una clase de la paleta `zinc` en un `className`, dado que la sección 2.3 declara que todas deben haberse sustituido por tokens.
  - Sirve de red de seguridad frente a la reintroducción de colores literales en componentes nuevos.

### Verificación manual
- Contraste de los 13 usos de `text-{accent}-200/300` en modo claro, comprobando legibilidad sobre fondo blanco.
- Recorrido de los 15 componentes migrados en ambos temas.

---

## 6. Plan de Tareas (Tasks)

- [x] **Fase 1: Fundamentos de Tailwind y Tokens**
  - [x] Declarar `@custom-variant dark` y `@theme inline` con los 9 tokens semánticos en `frontend/src/index.css`
  - [x] Declarar los valores de `:root` (oscuro) y del bloque claro, más la sobre-escritura de las barras de desplazamiento
  - [x] Insertar el script anti-parpadeo en `frontend/index.html` y corregir `lang="es"` y el `title` (hoy `lang="en"` y `title="frontend"`)
- [x] **Fase 2: Tests Primero (TDD)**
  - [x] Crear `frontend/tests/hooks/useTheme.test.tsx` con los 7 escenarios de `useTheme`
  - [x] Crear `frontend/tests/components/ThemeToggle.test.tsx`
  - [x] Crear el test de arquitectura `frontend/tests/theme-tokens.test.ts` que prohíbe clases `zinc`
  - [x] Ejecutar `pnpm run test` y confirmar que fallan por implementación ausente (fase roja)
- [x] **Fase 3: Implementación del Hook y del Toggle**
  - [x] Crear `frontend/src/types/theme.ts` con `ThemeMode`, `ResolvedTheme`, `THEME_STORAGE_KEY` y `THEME_OPTIONS`
  - [x] Implementar `frontend/src/hooks/useTheme.ts` (hook) y `frontend/src/components/layout/ThemeProvider.tsx` (provider) con resolución, persistencia, suscripción a `matchMedia` y acceso protegido a `localStorage`
  - [x] Implementar `frontend/src/components/layout/ThemeToggle.tsx` como boton unico con icono rotante, animacion y soporte de movimiento reducido
  - [x] Integrar `ThemeToggle` en la `Navbar` y envolver la aplicación en el proveedor de contexto del hook
- [x] **Fase 4: Migración de Componentes**
  - [x] Migrar `App.tsx` (contenedor raíz a `bg-base text-fg`) y `layout/Navbar.tsx`
  - [x] Migrar `ui/StatusBadge.tsx` y `containers/ContainersTable.tsx`, `ActionButtons.tsx`
  - [x] Migrar `containers/ContainerDetailModal.tsx`, `CreateContainerModal.tsx`, `ImageSelector.tsx`, `DeleteConfirmModal.tsx`
  - [x] Migrar `logs/LogsModal.tsx`, `LogsViewer.tsx`
  - [x] Migrar `stats/StatsModal.tsx`, `StatsSparkline.tsx`
  - [x] Migrar `terminal/TerminalModal.tsx`
  - [x] Ajustar el contraste en modo claro de los 13 usos de `text-{accent}-200/300` con variantes `dark:`
  - [x] Eliminar toda clase `zinc` remanente en `src/**` (verificado por el test de arquitectura)
- [x] **Fase 5: Superficies No HTML**
  - [x] Extraer la paleta de xterm.js a un mapa de temas en `frontend/src/components/terminal/`
  - [x] Implementar la paleta clara conmutada en caliente al cambiar el tema, sin recrear la instancia de Terminal
- [x] **Fase 6: Verificación y Quality Gates**
  - [x] Ejecutar y aprobar la suite frontend (`pnpm run test`)
  - [x] Ejecutar `pnpm run lint` (Oxlint) y `pnpm run build` (`tsc -b && vite build`)
  - [x] Verificar que la suite backend sigue intacta (`make backend-test`) y que el lint del backend no se ha visto afectado
  - [x] Verificar el contraste de los textos de acento en modo claro por cálculo de luminancia WCAG (los 9 tonos resultantes superan 3:1; los de texto normal, 4.5:1)
  - [x] Recorrido visual en navegador de los 15 componentes en modo claro (revisión subjetiva de jerarquía y estratificación) — validado por el usuario
  - [x] Marcar todas las tareas como completadas (`[x]`) en este documento
