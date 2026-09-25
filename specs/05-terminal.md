# SPEC-05: Terminal Interactivo Embebido para Contenedores (`docker exec`)

## 1. Contexto y Objetivos
- **Problema**: Para inspeccionar el estado interno, ejecutar scripts de depuración, verificar archivos de configuración o ejecutar comandos en contenedores locales, los desarrolladores deben abrir una ventana de terminal externa y recordar el comando `docker exec -it <container_id_o_nombre> /bin/sh` (o `/bin/bash`). Esto fragmenta el flujo de trabajo y ralentiza el diagnóstico.
- **Objetivo**: Proveer una terminal interactiva embebida en el panel web de DockPilot utilizando `@xterm/xterm`, conectada mediante WebSockets a una sesión interactiva TTY de Docker (`aiodocker.containers.exec`). El usuario podrá interactuar en tiempo real con la shell del contenedor, redimensionar la terminal fluidamente (`addon-fit`) y cerrar la sesión sin dejar procesos huérfanos.
- **Alcance**:
  - Incluye:
    - Canal WebSocket `/ws/containers/{id}/terminal` con asignación interactiva de pseudo-terminal (PTY: `stdin=True`, `stdout=True`, `stderr=True`, `tty=True`).
    - Soporte para selector de shell (`/bin/sh` y `/bin/bash` con fallback inteligente).
    - Eventos de redimensionamiento bidireccional (`resize` de columnas y filas) sincronizados con Docker Engine.
    - Componente modal `TerminalModal` y visor `TerminalViewer` con renderizado rápido mediante Canvas/DOM de XTerm.js, tema visual oscuro acorde a la interfaz y botones de acceso rápido (`Clear`, `Reconnect`, cambio de shell).
    - Botón de acceso directo en las acciones de la tabla de contenedores (`ActionButtons`).
  - No incluye (en esta spec):
    - Subida o descarga directa de archivos SFTP vía GUI (se gestiona vía comandos de terminal habituales).
    - Multiplexación de pestañas múltiples de terminal simultáneas dentro de un mismo modal (se abrirá una sesión activa a la vez).

---

## 2. Contrato de Datos y Protocolo de Comunicación

### 2.1. Backend (Pydantic v2) - `app/schemas/terminal.py`
```python
from typing import Optional, Literal
from pydantic import BaseModel, Field

class TerminalResizeMessage(BaseModel):
    type: Literal["resize"] = "resize"
    cols: int = Field(..., ge=10, le=500, description="Número de columnas de la terminal")
    rows: int = Field(..., ge=5, le=200, description="Número de filas de la terminal")

class TerminalInputMessage(BaseModel):
    type: Literal["stdin"] = "stdin"
    data: str = Field(..., description="Caracteres o secuencias de escape enviados a la entrada estándar")
```

### 2.2. Frontend (TypeScript) - `src/types/terminal.ts`
```typescript
export type TerminalMessageType = 'stdin' | 'resize' | 'stdout' | 'system' | 'error';

export interface TerminalClientMessage {
  type: 'stdin' | 'resize';
  data?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalServerMessage {
  type: 'stdout' | 'system' | 'error';
  data?: string;
  message?: string;
}
```

---

## 3. Protocolo WebSocket (`/ws/containers/{id}/terminal`)

- **Ruta**: `/ws/containers/{id}/terminal`
- **Query Params**:
  - `shell` (opcional, string): Shell inicial a ejecutar. Valores típicos: `/bin/sh`, `/bin/bash`. Default: `/bin/sh`.
  - `user` (opcional, string): Usuario del contenedor (ej. `root`, `node`, `postgres`). Default: `""` (usuario por defecto del contenedor).
  - `cols` (opcional, int): Ancho inicial en columnas. Default: `80`.
  - `rows` (opcional, int): Alto inicial en filas. Default: `24`.

### Mensajes Enviados por el Cliente (Frontend ➔ Backend):
1. **Entrada de Teclado (`stdin`)**:
   - Envío de texto crudo o JSON:
   ```json
   { "type": "stdin", "data": "ls -la\r" }
   ```
   *(También se acepta string plano recibido en el socket como entrada de stdin para máxima compatibilidad con XTerm).*
2. **Redimensionamiento de Ventana (`resize`)**:
   ```json
   { "type": "resize", "cols": 120, "rows": 35 }
   ```

### Mensajes Emitidos por el Servidor (Backend ➔ Frontend):
1. **Salida de Terminal (`stdout` / PTY stream)**:
   - Datos emitidos como texto crudo UTF-8 o JSON:
   ```json
   { "type": "stdout", "data": "\u001b[32mroot@container:/# \u001b[0m" }
   ```
2. **Mensajes del Sistema**:
   ```json
   { "type": "system", "data": "--- Conectado a la terminal [/bin/sh] del contenedor ---" }
   ```
3. **Errores del Servidor**:
   ```json
   { "type": "error", "message": "No se pudo iniciar la shell especificada" }
   ```

### Cierre y Limpieza de Recursos:
- **Código 4404**: Contenedor no encontrado.
- **Código 4400**: El contenedor no está en ejecución (estado `exited` o `paused`).
- **Código 1000**: Desconexión normal (usuario ejecuta `exit` o cierra el modal).
- Al desconectarse el WebSocket, el backend cierra inmediatamente el stream `aiodocker.execs.Stream`, liberando el proceso en el daemon Docker.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Terminal interactivo embebido para contenedores Docker
  Como desarrollador de software
  Quiero abrir una terminal interactiva en el navegador conectada a mi contenedor
  Para ejecutar comandos, depurar procesos y configurar el entorno sin salir de la interfaz

  Antecedentes:
    Dado que el servidor backend de DockPilot está en ejecución
    Y la conexión al socket de Docker está establecida

  Escenario: Apertura exitosa de terminal interactiva con /bin/sh
    Dado que existe un contenedor en ejecución con identificador "backend-api"
    Cuando el cliente frontend conecta por WebSocket a "/ws/containers/backend-api/terminal?shell=/bin/sh"
    Entonces la conexión WebSocket es aceptada
    Y el servidor inicia una sesión exec con TTY y PTY interactivo
    Y el cliente recibe el mensaje de bienvenida y el prompt de la shell

  Escenario: Envío de comandos y recepción de salida interactiva
    Dado una sesión WebSocket activa en el terminal del contenedor "backend-api"
    Cuando el usuario presiona teclas en la terminal y envía "echo 'hola dockpilot'\r"
    Entonces el servidor transmite los bytes al proceso hijo mediante stdin
    Y el cliente recibe en stdout la respuesta conteniendo "hola dockpilot"

  Escenario: Redimensionamiento dinámico de la terminal
    Dado una sesión WebSocket activa en el terminal
    Cuando el usuario cambia el tamaño de la ventana o modal
    Y el cliente frontend emite un mensaje JSON con '{"type": "resize", "cols": 120, "rows": 40}'
    Entonces el backend invoca el resize de la instancia exec en Docker con los nuevos valores de ancho y alto

  Escenario: Intento de terminal en contenedor detenido
    Dado un contenedor con identificador "db-detenida" cuyo estado es "exited"
    Cuando un cliente intenta conectar por WebSocket a "/ws/containers/db-detenida/terminal"
    Entonces la conexión es rechazada o cerrada inmediatamente con código 4400
    Y el cliente visualiza un mensaje informando que el contenedor debe estar activo para abrir una terminal

  Escenario: Cierre de terminal al escribir exit
    Dado una sesión interactiva abierta en el terminal
    Cuando el usuario ingresa el comando "exit\r"
    Entonces el proceso del shell finaliza en el contenedor
    Y el servidor WebSocket envía el cierre limpio con código 1000
    Y el frontend muestra la notificación de sesión finalizada con opción a reconectar
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest` + `pytest-asyncio` + `starlette.testclient`)
- `tests/test_ws_terminal.py`:
  - `test_ws_terminal_not_found`: Verifica código 4404 cuando el contenedor no existe.
  - `test_ws_terminal_container_stopped`: Verifica código 4400 cuando el contenedor no está `running`.
  - `test_ws_terminal_connect_and_stream`: Simula conexión interactiva, envío de entrada `stdin` y recepción de `stdout`.
  - `test_ws_terminal_resize_message`: Envío de mensaje `resize` y verificación de llamada al método `resize` de Docker Exec.
  - `test_ws_terminal_clean_disconnect`: Desconexión de cliente y verificación de cierre del stream en el servidor.

### Frontend (`vitest` + `@testing-library/react`)
- `tests/components/TerminalModal.test.tsx`:
  - Renderizado del modal cuando `isOpen=true` y no renderizado cuando `isOpen=false`.
  - Verificación de botones de control (`Cerrar`, `Limpiar pantalla`, `Reconectar`).
  - Verificación del selector de shell (`/bin/sh` vs `/bin/bash`).
  - Comportamiento ante desconexión o contenedor detenido.

---

## 6. Plan de Tareas (Tasks)

- [x] **Fase 1: Dependencias y Contratos**
  - [x] Instalar dependencias en frontend: `@xterm/xterm` y `@xterm/addon-fit`
  - [x] Crear modelos Pydantic en `backend/app/schemas/terminal.py`
  - [x] Crear tipos TypeScript en `frontend/src/types/terminal.ts`
- [x] **Fase 2: Tests Primero en Backend (TDD)**
  - [x] Añadir fixtures de mock para `container.exec` y `exec.start` en `backend/tests/conftest.py`
  - [x] Crear suite de pruebas `backend/tests/test_ws_terminal.py`
- [x] **Fase 3: Implementación Backend**
  - [x] Implementar servicio de terminal y endpoint WebSocket `/ws/containers/{id}/terminal` en `backend/app/api/v1/ws.py`
  - [x] Validar y pasar todos los tests de backend (`pytest -v`)
- [x] **Fase 4: Tests Primero en Frontend**
  - [x] Crear tests para el visor y modal de terminal en `frontend/tests/components/TerminalModal.test.tsx`
- [x] **Fase 5: Implementación Frontend**
  - [x] Implementar componente de terminal XTerm `frontend/src/components/terminal/TerminalViewer.tsx` con soporte para `@xterm/addon-fit` y redimensionamiento automático
  - [x] Implementar modal contenedor `frontend/src/components/terminal/TerminalModal.tsx` con controles de shell y estado de conexión
  - [x] Añadir botón de terminal (ícono de terminal de `lucide-react`) en `frontend/src/components/containers/ActionButtons.tsx`
  - [x] Integrar el modal de terminal en `frontend/src/App.tsx`
- [x] **Fase 6: Verificación y Quality Gates**
  - [x] Ejecutar suite de pruebas backend (`PYTHONPATH=. pytest -v`) (28/28 passed)
  - [x] Ejecutar suite de pruebas frontend (`pnpm run test`) (25/25 passed)
  - [x] Ejecutar linter (`oxlint`) y build (`tsc -b && vite build`) (0 errors, 0 warnings)
  - [x] Marcar todas las tareas en este documento como completadas (`[x]`)
