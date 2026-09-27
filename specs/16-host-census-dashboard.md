# SPEC-16: Dashboard de censo del host

## 1. Contexto y Objetivos
- **Problema**: El panel de detalle del host (`SystemDetailPanel`) lo presenta todo en texto y números sueltos: «4 imágenes · 2 en uso», «1.2 GB recuperables 50.0%», y una lista de los mayores consumidores. Para hacerse una idea del estado hay que leerlo entero y mentalmente sumar. El proyecto **no tiene** librería de gráficas: sus únicas visualizaciones son la barra `width:%` de `StatsModal` y el `StatsSparkline` de SVG hecho a mano.
- **Objetivo**: Convertir ese panel en un resumen visual del estado del host con gráficas de **censo** (instantáneas), sin librería de terceros y sin tocar el backend.
- **Alcance**:
  - Incluye:
    - **Estados de contenedores**: barra apilada con corriendo / detenidos / pausados, con su recuento.
    - **Disco por categoría**: barra apilada con imágenes, contenedores, volúmenes, caché de build y capas.
    - **Usado vs recuperable** por categoría, que es la cifra accionable de la spec.
    - **Mayores consumidores** como barras proporcionales en vez de listas de texto.
    - Una **paleta de gráfico** en el sistema de temas, para que las gráficas sigan al modo claro y oscuro.
    - **Cerrar el agujero del guard de tokens**, que hoy no escanea atributos `stroke` y `fill` de un SVG.
  - No incluye (en esta spec):
    - **Series temporales.** CPU, memoria, red y disco en el tiempo necesitan histórico, y no hay ninguno: el backend es sin estado, sin base de datos y sin buffer. Es SPEC-17, y allí habrá que decidir si el buffer vive en el navegador o en el backend.
    - **Uso de CPU o memoria del host.** `GET /containers/{id}/stats` es **por contenedor**, y su `cpu_percent` va multiplicado por `online_cpus`, así que 100% es *un* núcleo saturado. Sumar contenedores y llamarlo «host» sería mentir: Docker solo contabiliza lo suyo, y en un equipo con otras cosas corriendo la gráfica no reflejaría el host.
    - **Red y E/S en el tiempo.** `network_rx_bytes` y `block_write_bytes` son contadores acumulados desde el arranque; su línea sería una rampa monótona. Hace falta deltas entre muestras, o sea, histórico.
    - **Proyectos compose en este panel.** Requeriría una segunda fuente de datos en un panel que hoy solo habla del host, y ataría SPEC-11 a la vista de sistema. Las compose tienen su propia pestaña.
    - **Zoom, rangos temporales o comparativas entre periodos.** Sin histórico no hay nada que comparar.

---

## 2. Contrato de Datos (Schemas & Types)

**No hay cambios de backend.** Todo lo que necesitan las gráficas ya viaja en `SystemOverview`, y el desglose de estados ya viene en `SystemInfo` desde `/info` del daemon:

| Dato | Campo | Gráfica |
| :--- | :--- | :--- |
| Estados de contenedores | `info.containers_running`, `containers_stopped`, `containers_paused`, `containers_total` | Barra apilada de estados |
| Disco por categoría | `usage.images`, `usage.containers`, `usage.volumes` (`.total_size`), `usage.build_cache_size`, `usage.layers_size` | Barra apilada de disco |
| Usado vs recuperable | `usage.*.reclaimable`, `usage.*.total_size`, `.total_count`, `.active_count` | Barra de doble segmento por categoría |
| Mayores consumidores | `top_images[]`, `top_volumes[]` (`.name`, `.size`, `.detail`) | Barras proporcionales |

### 2.1 Nuevos tokens de tema

La paleta actual son diez tokens **neutros**. Una gráfica por categorías necesita color, y sin extender el tema saldría gris sobre gris. Se añaden tokens semánticos al `@theme` de `index.css`, con la misma pareja claro/oscuro que usa el resto del sistema:

```css
/* Paleta de gráficas (SPEC-16). Semántica, no decorativa: el significado de un
   color es el mismo en toda la aplicación, y por eso se declara una sola vez. */
--color-chart-running: ...      /* en marcha */
--color-chart-stopped: ...      /* detenidos, incluidos creados y muertos */
--color-chart-paused: ...       /* pausados */
--color-chart-images: ...       /* disco de imágenes */
--color-chart-containers: ...   /* disco de contenedores */
--color-chart-volumes: ...      /* disco de volúmenes */
--color-chart-cache: ...        /* caché de build */
--color-chart-reclaimable: ...  /* la parte recuperable de una barra */
```

Se reutilizan los tres tonos semánticos que `StatsModal` ya emplea para los niveles (emerald, amber, rose) más un azul y un violeta, para que el panel de sistema y el de estadísticas hablen el mismo idioma de color.

---

## 3. Mecánica

### 3.1 Dónde vive, y por qué no es una pestaña nueva
El dashboard **es** el `SystemDetailPanel` que ya existe, abierto desde la franja de resumen. Una pestaña nueva habría repetido los datos de censo que ese panel ya enseña, y la franja de resumen tiene la afordancia de expandir. Crecer es añadir secciones, no una vista nueva.

### 3.2 Cómo se dibuja, y por qué sin librería
Las cuatro gráficas son barras apiladas y barras proporcionales: un `div` con `width` porcentual, que es literalmente lo que ya hace `StatsModal` con su barra de nivel. Recharts o Chart.js aportarían un sistema de color propio, SVG que habría que re-tematizar para que pase el guard, y entre 50 y 100 kB a cambio de dibujar rectángulos.

Para la etiqueta accesible y el estado vacío se sigue el patrón de `StatsSparkline`: `role="img"` con `aria-label` que describa el dato, y un estado vacío explícito. Un gráfico sin equivalente textual es invisible para un lector de pantalla, y un `div` vacío delata que no hay nada.

### 3.3 El agujero del guard de tokens
`theme-tokens.test.ts` recorre **líneas de código buscando clases de utilidad**, así que un `stroke="#3b82f6"` en un atributo SVG pasa desapercibido. Hoy ya hay dos: los sparklines de CPU y de memoria usan `#3b82f6` y `#a855f7` fijos, que **no cambian con el tema**. Un dashboard es justo donde eso se multiplicaría.

Se hacen las dos cosas: las gráficas nuevas usan `var(--color-chart-*)`, y el guard deja de tener el agujero, escaneando también `stroke=`, `fill=` y `stop-color=` con valor literal. Los dos hexos existentes pasan a token, que es de paso la corrección del bug de fondo.

### 3.4 Decisiones de lectura, que es donde se juega la utilidad
- **Una barra por categoría, no una gráfica de tartas.** Con cuatro o cinco categorías la longitud se compara con precisión y el ángulo no. La barra también se lee sin ambigüedad en un texto alternativo.
- **Los tramos van ordenados de mayor a menor.** El orden de declaración es ruido cuando lo que importa es qué se lleva el espacio.
- **Cada barra lleva su número al lado.** La gráfica localiza la proporción; el número da el valor. Con cifras de gigas, un porcentaje en un texto no basta.
- **Una categoría con valor cero no se dibuja.** Un tramo de ancho cero es indistinguible de un hueco, y su leyenda solo añade ruido.
- **Si el total es cero, se dice "sin datos" y no se dibuja una barra vacía** que parecería un 0 %.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Dashboard de censo del host
  Como usuario de DockPilot
  quiero ver el estado del host de un vistazo
  Para no tener que leer el panel entero y sumar mentalmente

  Antecedados:
    Dado que el servidor backend de DockPilot está en ejecución
    Y el resumen del host se ha cargado

  Escenario: Los estados de los contenedores se ven de un vistazo
    Dado que hay 5 contenedores, 3 en marcha, 1 detenido y 1 pausado
    Cuando se abre el panel de detalle del host
    Entonces se muestra una barra con los tres tramos
    Y cada tramo lleva su número al lado
    Y la suma de los tramos es el total de contenedores

  Escenario: El desglose de estados no necesita ir al backend
    Dado que el resumen del host ya está cargado
    Cuando se dibujan los estados de los contenedores
    Entonces no se hace ninguna petición nueva al servidor

  Escenario: El disco se reparte por categoría
    Dado que hay espacio ocupado en imágenes, contenedores, volúmenes y caché de build
    Cuando se abre el panel de detalle del host
    Entonces se muestra una barra apilada con una categoría por espacio ocupado
    Y las categorías están ordenadas de mayor a menor

  Escenario: Se distingue lo ocupado de lo recuperable
    Dado que una categoría tiene parte del espacio recuperable
    Cuando se muestra su barra
    Entonces el tramo recuperable va en su propio color
    Y se dice cuántas unidades son recuperables y cuántas ocupa la categoría

  Escenario: Una categoría sin espacio no aparece
    Dado que una categoría ocupa cero bytes
    Cuando se dibuja la barra de disco
    Entonces esa categoría no tiene tramo
    Y no aparece en la leyenda

  Escenario: Sin nada que dibujar se dice, no se enseña una barra vacía
    Dado que no hay ningún contenedor en el host
    Cuando se dibujan los estados de los contenedores
    Entonces se indica que no hay contenedores
    Y no se dibuja ninguna barra

  Escenario: Los mayores consumidores se comparan de un vistazo
    Dado que hay varios volúmenes ordenados por tamaño
    Cuando se muestra la lista de mayores consumidores
    Entonces cada uno tiene una barra proporcional a su tamaño
    Y la barra más larga es la del mayor volumen

  Escenario: Las gráficas se adaptan al modo claro y oscuro
    Dado que el panel de detalle se muestra en modo claro
    Y después en modo oscuro
    Entonces los colores de las gráficas cambian con el tema
    Y ningún color está escrito a mano en el componente

  Escenario: El texto de la ayuda no miente
    Dado que un lector de pantalla recorre el panel de detalle
    Entonces cada gráfica tiene una descripción que dice qué representa
    Y la descripción incluye los valores, no solo el nombre de la categoría
```

---

## 5. Plan de Pruebas Automatizadas

### Frontend (`vitest` + `@testing-library/react`)
- `tests/components/system/charts/StackedBar.test.tsx`:
  - Reparte el ancho entre los tramos y suma 100 %.
  - Cada tramo lleva su valor numérico visible.
  - Una categoría a cero no dibuja tramo ni leyenda.
  - Con total cero dice "sin datos" y no dibuja barra.
  - El `aria-label` de la gráfica incluye los valores.
  - Ordena los tramos de mayor a menor.
  - Un tramo con color desconocido no rompe el render.
- `tests/components/system/charts/ConsumerBars.test.tsx`:
  - La barra más larga es la del mayor consumidor.
  - Lista vacía dice "sin datos".
  - Un solo consumidor ocupa el ancho completo.
- `tests/components/system/SystemDetailPanel.test.tsx` (ampliar):
  - Se muestran las cuatro secciones sin cambiar la firma del componente.
  - Cambiar de pestaña y volver no vuelve a pedir el resumen.
  - El botón de ir a la vista sigue funcionando con la barra nueva.
- `tests/theme-tokens.test.ts` (ampliar):
  - Falla ante un `stroke="#ff0000"` literal en un SVG.
  - Falla ante un `fill="#ff0000"` literal.
  - Acepta `stroke="var(--color-chart-images)"` y `stroke="currentColor"`.
  - Los sparklines de `StatsModal` ya no llevan hexos literales.

### Backend
Ninguno. La spec no toca el backend, y los tests de `system` siguen siendo la red de seguridad del contrato de datos.

---

## 6. Plan de Tareas (Tasks)

> Las seis fases quedaron completadas y verificadas contra el resumen real del host.

- [x] **Fase 1: Paleta y guard**
  - [x] Declarar los ocho tokens `--color-chart-*` en `index.css`, con su par claro/oscuro
  - [x] Migrar los dos hexos de `StatsModal` a tokens, de paso corrigiendo que no seguían el tema
  - [x] Ampliar `theme-tokens.test.ts` para escanear `stroke=`, `fill=` y `stop-color=` literales
  - [x] Ejecutar el test y confirmar que detecta un `stroke="#ff0000"` de prueba (fase roja)
- [x] **Fase 2: Tests Primero en los Gráficos**
  - [x] `frontend/tests/components/system/charts/StackedBar.test.tsx`
  - [x] `frontend/tests/components/system/charts/ConsumerBars.test.tsx`
  - [x] Ejecutar `vitest` y confirmar que fallan por implementación ausente
- [x] **Fase 3: Componentes de Gráfica**
  - [x] `StackedBar.tsx`: tramos proporcionales, leyenda con valores, `aria-label`, estado vacío
  - [x] `ConsumerBars.tsx`: barras proporcionales con el nombre y el tamaño
  - [x] Validar aprobación de ambos tests al 100 %
- [x] **Fase 4: Tests Primero en el Panel**
  - [x] Ampliar `frontend/tests/components/system/SystemDetailPanel.test.tsx` con las cuatro secciones
  - [x] Ejecutar `vitest` y confirmar que falla por implementación ausente
- [x] **Fase 5: Integración en el Panel**
  - [x] Sección de estados de contenedores
  - [x] Sección de disco por categoría, con usado vs recuperable
  - [x] Convertir la lista de mayores consumidores en barras, conservando el enlace a la vista
  - [x] Validar aprobación de los tests del panel al 100 %
- [x] **Fase 6: Verificación, Gates y Documentación**
  - [x] `tsc`, `oxlint`, `vitest` y `vite build`
  - [x] Comprobar en el navegador el panel en modo claro y en modo oscuro
  - [x] Actualizar la ayuda in-app para mencionar el resumen visual
  - [x] Actualizar `agent.md` (árbol, paleta de gráfico) y marcar las tareas como `[x]`
