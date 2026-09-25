# SPEC-03: Creación de Contenedores y Búsqueda de Imágenes

## 1. Contexto y Objetivos
- **Problema**: Crear contenedores requiriendo escribir el nombre exacto de la imagen a mano es propenso a errores tipográficos y obliga al usuario a memorizar tags o consultar externamente Docker Hub.
- **Objetivo**: Proveer una experiencia integral que permita:
  1. Explorar y seleccionar imágenes que ya existen en el host local.
  2. Buscar imágenes oficiales y de la comunidad directamente en Docker Hub.
  3. Desplegar el nuevo contenedor configurando puertos, variables de entorno, volúmenes y comandos con auto-pull si es necesario.
- **Alcance**:
  - Incluye:
    - Endpoint `GET /api/v1/images/local` para autocompletado de imágenes ya descargadas.
    - Endpoint `GET /api/v1/images/search?term=...` para búsqueda en vivo en Docker Hub.
    - Endpoint `POST /api/v1/containers` para crear y arrancar el contenedor.
    - Modal en frontend con selector inteligente de imagen (Imágenes Locales, Búsqueda en Docker Hub y Plantillas rápidas de 1 click).

---

## 2. Contrato de Datos (Schemas & Types)

### Backend (Pydantic v2) - `app/schemas/container.py` y `app/schemas/image.py`
```python
from typing import List, Optional, Dict
from pydantic import BaseModel, Field

class ImageSearchResult(BaseModel):
    name: str
    description: str = ""
    is_official: bool = False
    star_count: int = 0

class LocalImageSummary(BaseModel):
    id: str
    tags: List[str] = Field(default_factory=list)
    size: int = 0
    created: int = 0

class PortBindingConfig(BaseModel):
    host_port: int
    container_port: int
    protocol: str = "tcp"

class VolumeBindingConfig(BaseModel):
    host_path: str
    container_path: str
    mode: str = "rw"  # "rw" | "ro"

class CreateContainerRequest(BaseModel):
    image: str = Field(..., description="Nombre y tag de la imagen, ej. nginx:alpine")
    name: Optional[str] = Field(None, description="Nombre deseado para el contenedor")
    ports: List[PortBindingConfig] = Field(default_factory=list)
    env: Dict[str, str] = Field(default_factory=dict, description="Variables de entorno clave-valor")
    volumes: List[VolumeBindingConfig] = Field(default_factory=list)
    command: Optional[str] = Field(None, description="Comando opcional para sobrescribir CMD")
    restart_policy: str = Field("no", description="Política: no, always, unless-stopped, on-failure")
    start_now: bool = Field(True, description="Arrancar el contenedor inmediatamente tras crearlo")

class CreateContainerResponse(BaseModel):
    id: str
    name: str
    image: str
    status: str
    started: bool
    message: str
```

### Frontend (TypeScript) - `src/types/docker.ts`
```typescript
export interface ImageSearchResult {
  name: string;
  description: string;
  is_official: boolean;
  star_count: number;
}

export interface LocalImageSummary {
  id: string;
  tags: string[];
  size: number;
  created: number;
}

export interface PortBindingConfig {
  host_port: number;
  container_port: number;
  protocol: 'tcp' | 'udp';
}

export interface VolumeBindingConfig {
  host_path: string;
  container_path: string;
  mode: 'rw' | 'ro';
}

export interface CreateContainerRequest {
  image: string;
  name?: string;
  ports: PortBindingConfig[];
  env: Record<string, string>;
  volumes: VolumeBindingConfig[];
  command?: string;
  restart_policy: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  start_now: boolean;
}

export interface CreateContainerResponse {
  id: string;
  name: string;
  image: string;
  status: string;
  started: boolean;
  message: string;
}
```

---

## 3. Contrato de API REST

| Método | Endpoint | Query / Body | Código Respuesta | Descripción |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/images/local` | Ninguno | `200 OK`: `List[LocalImageSummary]` | Lista las imágenes almacenadas localmente en el host |
| `GET` | `/api/v1/images/search` | `term` (str), `limit` (int, default=10) | `200 OK`: `List[ImageSearchResult]` | Busca imágenes públicas en Docker Hub vía Docker Engine |
| `POST` | `/api/v1/containers` | `CreateContainerRequest` (JSON) | `201 Created`: `CreateContainerResponse` | Crea un contenedor y opcionalmente lo arranca |

### Respuestas de Error
- `400 Bad Request`: Si falta el término de búsqueda o la configuración de puertos es inválida.
- `404 Not Found`: Si la imagen no existe ni local ni remotamente.
- `409 Conflict`: Si el nombre del contenedor ya existe o si el puerto del host está en conflicto.
- `503 Service Unavailable`: Si el daemon Docker no responde.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Búsqueda de imágenes y despliegue de nuevos contenedores
  Como desarrollador de aplicaciones
  Quiero buscar imágenes locales y remotas para crear contenedores fácilmente
  Para evitar escribir nombres de imágenes a mano y configurar mis servicios rápidamente

  Antecedentes:
    Dado que el backend de DockPilot está en ejecución y conectado al socket Docker

  Escenario: Búsqueda remota de imágenes en Docker Hub
    Cuando el usuario solicita "GET /api/v1/images/search?term=redis&limit=5"
    Entonces el sistema responde con código HTTP 200
    Y devuelve una lista con nombres de imágenes, cantidad de estrellas y bandera de oficial
    Y entre los resultados se encuentra la imagen oficial "redis"

  Escenario: Listado de imágenes locales descargadas
    Dado que el daemon Docker tiene imágenes descargadas en local
    Cuando el usuario solicita "GET /api/v1/images/local"
    Entonces el sistema responde con código HTTP 200
    Y devuelve los tags de las imágenes locales y su tamaño en bytes

  Escenario: Selección y creación de contenedor con inicio inmediato
    Dado que el usuario selecciona una imagen de los resultados de búsqueda
    Cuando envía una petición "POST /api/v1/containers" con "start_now: true"
    Entonces el sistema descarga la imagen si no existe localmente
    Y crea el contenedor y lo arranca con código HTTP 201
    Y devuelve "started: true"

  Escenario: Creación con mapeo de puertos y variables de entorno
    Dado un request con imagen "postgres:16-alpine"
    Y puertos mapeados "5432:5432" y variable "POSTGRES_PASSWORD=secret"
    Cuando se envía la petición de creación
    Entonces el sistema crea el contenedor con la configuración de red y variables inyectadas

  Escenario: Error por término de búsqueda vacío
    Cuando el usuario solicita "GET /api/v1/images/search?term="
    Entonces el sistema responde con código HTTP 400
    Y devuelve un mensaje solicitando un término de búsqueda válido
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest` + `pytest-asyncio` + `httpx`)
- `tests/test_images_search.py`:
  - `test_list_local_images`: Devuelve lista de imágenes locales parseadas.
  - `test_search_images_success`: Mock de búsqueda en Docker Hub con resultados formateados.
  - `test_search_images_empty_term`: Validación de término requerido (400).
- `tests/test_create_container.py`:
  - `test_create_container_minimal_success`: Creación exitosa (201).
  - `test_create_container_with_ports_and_env`: Inyección de puertos y variables de entorno.
  - `test_create_container_conflict`: Manejo de colisión de nombre de contenedor (409).

### Frontend (`vitest` + `@testing-library/react`)
- `tests/components/CreateContainerModal.test.tsx`:
  - Selector de imágenes con autocompletado local y búsqueda en Docker Hub.
  - Añadir y quitar dinámicamente mapeos de puertos y variables de entorno.
  - Selección de plantilla rápida (ej. click en "Redis" o "Nginx" completa automáticamente la imagen).
  - Envío del formulario y feedback de carga.

---

## 6. Plan de Tareas (Tasks)

- [x] **Fase 1: Contratos y Schemas**
  - [x] Añadir `ImageSearchResult` y `LocalImageSummary` en `backend/app/schemas/image.py`
  - [x] Añadir `PortBindingConfig`, `VolumeBindingConfig`, `CreateContainerRequest` y `CreateContainerResponse` en `backend/app/schemas/container.py`
  - [x] Añadir tipos correspondientes en `frontend/src/types/docker.ts`
- [x] **Fase 2: Tests Primero en Backend (TDD)**
  - [x] Añadir fixtures para `images.list` e `images/search` en `backend/tests/conftest.py`
  - [x] Crear `backend/tests/test_images_search.py`
  - [x] Crear `backend/tests/test_create_container.py`
- [x] **Fase 3: Implementación Backend**
  - [x] Implementar `ImageService` en `backend/app/services/image_service.py` con listado local y búsqueda remota (`_query_json`)
  - [x] Implementar `create_container` en `backend/app/services/container_service.py` con auto-pull si la imagen falta
  - [x] Crear endpoints en `backend/app/api/v1/images.py` y `backend/app/api/v1/containers.py`
  - [x] Registrar router de imágenes en `backend/app/api/router.py` y verificar `pytest -v` (todos en verde)
- [x] **Fase 4: Tests Primero en Frontend**
  - [x] Escribir tests en `frontend/tests/components/CreateContainerModal.test.tsx`
- [x] **Fase 5: Implementación Frontend**
  - [x] Añadir métodos `searchImages`, `getLocalImages`, `createContainer` en `frontend/src/services/dockerApi.ts`
  - [x] Crear componente `frontend/src/components/containers/ImageSelector.tsx` con tabs (Locales / Docker Hub / Presets rápidos)
  - [x] Crear componente `frontend/src/components/containers/CreateContainerModal.tsx` integrando el selector de imágenes y campos dinámicos
  - [x] Añadir botón "+ Nuevo Contenedor" en `frontend/src/components/layout/Navbar.tsx` y conectar modal en `frontend/src/App.tsx`
- [x] **Fase 6: Verificación y Quality Gates**
  - [x] Ejecutar y validar `pytest -v` en backend (23/23 passed)
  - [x] Ejecutar y validar `pnpm run test` en frontend (18/18 passed)
  - [x] Ejecutar `pnpm run lint` y `pnpm run build` (0 warnings, 0 errors)
  - [x] Marcar todas las tareas completadas en este documento
