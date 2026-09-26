# SPEC-10: Gestión de Redes Docker

## 1. Contexto y Objetivos
- **Problema**: SPEC-01 muestra las redes de un contenedor en su detalle, pero DockPilot no tiene ninguna vista de las redes del host. Docker crea redes automáticamente al publicar puertos (`bridge`) y al usar Compose, y el usuario no tiene forma de saber cuáles existen, cuáles están conectadas a qué, ni de quitar las que ya no usa. Las redes huerfanas de proyectos pasados consumen un rango de subredes completo cada una (en el host de referencia hay 5 redes ocupando `172.17.0.0/16` y `172.18.0.0/16`), lo que agota el espacio de direccionamiento IPv4 disponible sin que nada lo indique. Además, el panel no puede restringir los puertos al crear un contenedor (SPEC-03), que es la forma más común de necesitar una red propia.
- **Objetivo**: Incorporar la quinta pestaña `Redes` con el inventario de redes del host, su detalle (driver, subredes, puerta de enlace, opciones, contenedores conectados), la creación de redes personalizadas con subred y puerta de enlace opcionales, el borrado protegido y la limpieza de las no usadas.
- **Alcance**:
  - Incluye:
    - Endpoints REST `GET /api/v1/networks`, `GET /api/v1/networks/{name}`, `POST /api/v1/networks` y `DELETE /api/v1/networks/{name}`.
    - Endpoint REST `POST /api/v1/networks/prune` para eliminar las no usadas.
    - Quinta pestaña `Redes` con el inventario y los indicadores de uso.
    - Modal de detalle con la configuración IPAM y los contenedores conectados.
    - Diálogo de creación con validación de nombre y subred.
    - Protección explícita frente al borrado de las redes predefinidas de Docker.
  - No incluye (en esta spec):
    - **Conectar y desconectar contenedores de una red en caliente** (`connect`/`disconnect`). Exige managing endpoints de red de contenedores en ejecución y es un flujo de riesgo alto para el beneficio que aporta en un panel local.
    - Configurar opciones avanzadas de driver (overlay, macvlan, IPAM por rango con `auxiliary_addresses`). La creación se limita al driver `bridge`, que es el caso de uso real.
    - Asignar una red al crear un contenedor. Requiere tocar el contrato de SPEC-03 (`HostConfig.NetworkMode` / `NetworkingConfig`) y es un incremento natural que puede apoyarse en esta spec una vez exista el inventario.
    -Conectividad a redes externas (overlay multi-host). El proyecto es de un solo host.

---

## 2. Contrato de Datos (Schemas & Types)

### 2.1 Backend (Pydantic v2) - `app/schemas/network.py`

```python
from typing import Any, Optional
from pydantic import BaseModel, Field

class NetworkSubnet(BaseModel):
    subnet: str = Field("", description="CIDR de la subred, p. ej. 172.18.0.0/16")
    gateway: str = Field("", description="Puerta de enlace de la subred")

class NetworkSummary(BaseModel):
    id: str = ""
    name: str
    driver: str = "bridge"
    scope: str = "local"
    internal: bool = Field(False, description="Sin salida a internet")
    attachable: bool = False
    enable_ipv6: bool = False
    created: str = Field("", description="Fecha de creación en ISO 8601")
    subnets: list[NetworkSubnet] = Field(default_factory=list)
    container_count: int = Field(0, description="Contenedores conectados; 0 = eliminable")
    is_builtin: bool = Field(
        False, description="True para las redes predefinidas de Docker (none, host, bridge); no se pueden borrar"
    )

class NetworkDetail(NetworkSummary):
    options: dict[str, Any] = Field(default_factory=dict)
    labels: dict[str, str] = Field(default_factory=dict)
    containers: list[str] = Field(default_factory=list, description="Nombres de los contenedores conectados")

class CreateNetworkRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=63, description="Nombre de la red")
    driver: str = Field("bridge", description="Solo se admite 'bridge' en esta versión")
    subnet: Optional[str] = Field(None, description="CIDR de la subred, p. ej. 172.20.0.0/16")
    gateway: Optional[str] = Field(None, description="Puerta de enlace; se ignora si no se indica subred")
    internal: bool = Field(False, description="Crear la red sin salida a internet")
    labels: dict[str, str] = Field(default_factory=dict)

class NetworkDeleteResponse(BaseModel):
    name: str
    deleted: bool
    message: str

class NetworkPruneResult(BaseModel):
    deleted: list[str] = Field(default_factory=list)
    message: str
```

### 2.2 Frontend (TypeScript) - `src/types/network.ts`

```typescript
export interface NetworkSubnet {
  subnet: string;
  gateway: string;
}

export interface NetworkSummary {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  attachable: boolean;
  enable_ipv6: boolean;
  created: string;
  subnets: NetworkSubnet[];
  container_count: number;
  is_builtin: boolean;
}

export interface NetworkDetail extends NetworkSummary {
  options: Record<string, unknown>;
  labels: Record<string, string>;
  containers: string[];
}

export interface CreateNetworkRequest {
  name: string;
  driver: string;
  subnet?: string | null;
  gateway?: string | null;
  internal: boolean;
  labels: Record<string, string>;
}

export interface NetworkDeleteResponse {
  name: string;
  deleted: boolean;
  message: string;
}

export interface NetworkPruneResult {
  deleted: string[];
  message: string;
}
```

---

## 3. Mecánica

### 3.1 Datos de listado frente a detalle

`networks.list()` **no** incluye ningún recuento de contenedores. Comprobado contra el daemon: las claves de cada entrada son exactamente

```text
Attachable, ConfigFrom, ConfigOnly, Created, Driver, EnableIPv4, EnableIPv6,
IPAM, Id, Ingress, Internal, Labels, Name, Options, Scope
```

No hay `Containers` ni ningún campo de recuento, así que `container_count` **no** es directo. Se deriva de `GET /containers/json`, leyendo `NetworkSettings.Networks` (un dict de nombre de red a su configuración), en **una sola llamada** para todas las redes. Es el mismo patrón que usa SPEC-08 para saber qué contenedores montan un volumen, y evita el N+1 de hacer un `show()` por red.

`show()` sí añade `Containers` (un dict indexado por id de contenedor, con `Name`, `EndpointID`, `MacAddress`, `IPv4Address` e `IPv6Address`) y `Status`, pero se reserva para el detalle, que es el único sitio donde hacen falta los nombres.

> Ojo con `IPAM.Config`: es `null` en las redes `none` y `host`, y una **lista** de dicts con `Subnet` y `Gateway` en el resto. Hay que tolerar ambos casos.

### 3.2 Redes predefinidas

Docker crea y gestiona `none`, `host` y `bridge`. Son `is_builtin: true` y quedan **excluidas** de:

- el borrado, tanto individual como por limpieza;
- la acción de limpieza, que nunca debe tocar una red predefinida.

Se detectan por nombre contra el conjunto `{none, host, bridge}` **y** se confirman con `scope` y `driver` (`none` tiene `driver: null` en el host de referencia). El nombre es la señal práctica que usa el propio Docker, y el flag se expone para que la interfaz pueda atenuar esas filas y explicar por qué.

### 3.3 Creación de una red

```python
{
  "Name": nombre,
  "Driver": "bridge",
  "CheckDuplicate": True,
  "Internal": internal,
  "Labels": labels,
}
```

Si se indica `subnet`, se añade la configuración IPAM explícita:

```python
"IPAM": {"Driver": "default", "Config": [{"Subnet": subnet, "Gateway": gateway}]}
```

`Gateway` solo se incluye junto a `Subnet`; enviarlo sin subred lo rechaza el daemon. Si no se indica subred, Docker asigna la siguiente libre automáticamente, que es el comportamiento por defecto comodo.

**Validación en el borde** (misma philosophy que SPEC-07): el nombre no puede estar vacío ni superar 63 caracteres, y debe casar con `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`. El prefijo `docker_` se rechaza, porque está reservado por Docker. El `subnet` se valida como CIDR IPv4 con `ipaddress.ip_network(..., strict=False)`, de modo que `172.20.0.5/16` se normaliza a `172.20.0.0/16` en lugar de fallar.

Un `409` del daemon por nombre duplicado se traduce a un mensaje que lo diga claramente.

### 3.4 Endpoints REST

| Método | Endpoint | Body / Query | Respuesta | Errores |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/networks` | — | `200 OK` (`NetworkSummary[]`) | `503` daemon no disponible |
| `GET` | `/api/v1/networks/{name}` | — | `200 OK` (`NetworkDetail`) | `404` inexistente |
| `POST` | `/api/v1/networks` | `CreateNetworkRequest` | `201 Created` (`NetworkDetail`) | `400` referencia inválida, `409` nombre duplicado |
| `DELETE` | `/api/v1/networks/{name}` | `force` (bool, def. `false`) | `200 OK` (`NetworkDeleteResponse`) | `400` red predefinida, `404` inexistente, `409` en uso |
| `POST` | `/api/v1/networks/prune` | — | `200 OK` (`NetworkPruneResult`) | `503` daemon no disponible |

`DELETE` nunca borra una red predefinida: se rechaza con `400` **antes** de contactar con el daemon, para no depender de que Docker lo impida. Con contenedores conectados se exige `force`.

`POST /prune` solo elimina redes sin contenedores y nunca las predefinidas.

### 3.5 Superficie de usuario

- Quinta pestaña `Redes` con contador de redes y de cuántas están en uso.
- `NetworksTable`: nombre, driver, subred, contenedores conectados y fecha. Las predefinidas se muestran atenuadas con una insignia `predefinida` y sin botón de borrar.
- Filtros: **Todas**, **En uso**, **No usadas** y **Predefinidas**, más buscador por nombre.
- `NetworkDetailModal`: driver, ámbito, indicadores (`internal`, `attachable`, `enable_ipv6`), subredes con su puerta de enlace, opciones, etiquetas y contenedores conectados.
- Creación: diálogo con nombre, subred y puerta de enlace opcionales, y un interruptor de red interna. Se explica que si se omite la subred Docker asigna la siguiente libre.
- `NetworkDeleteDialog` con confirmación explícita, reutilizando el patrón genérico de `DeleteConfirmModal` que ya introduce SPEC-07.

### 3.6 Notas de aiodocker 0.27.0 (verificadas)

- `DockerNetworks` expone `create`, `get`, `list` y `prune`, **pero no `delete`**. Para borrar hay que usar `await get(name)` y llamar a `DockerNetwork.delete()`, que **no admite ningún parámetro**: no hay forma de pedir `force` por esa vía. El borrado forzado se hace con `docker._query_json("networks/{name}", method="DELETE", params={"force": "true"})`, que es la misma técnica que usa la librería por dentro. `get()` es una corrutina: hay que hacer `await` antes de encadenar.
- `DockerNetwork` no tiene `inspect()`; el método de detalle se llama **`show()``.
- `create(config)` recibe un único dict; el nombre va dentro, no como argumento aparte.
- `prune(filters=None)` devuelve un dict (`{"NetworksDeleted": [...]}`).
- `DockerNetwork.connect()` y `disconnect()` existen, pero quedan fuera de alcance (§1).
- `create` recibe un único dict de configuración; el nombre va dentro, no como argumento aparte.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Gestión de redes Docker
  Como desarrollador de software
  Quiero ver y administrar las redes de mi host
  Para saber qué redes existen, cuáles uso y liberar las que ya no necesito

  Antecedentes:
    Dado que el servidor backend de DockPilot está en ejecución
    Y la conexión al socket de Docker está establecida

  Escenario: Inventario de redes
    Dado que el host tiene las redes "bridge", "host", "none" y "mi-app"
    Y la red "mi-app" tiene un contenedor conectado
    Cuando el usuario abre la vista "Redes"
    Entonces el sistema responde con código HTTP 200 al solicitar "GET /api/v1/networks"
    Y cada red informa de "name", "driver", "subnets" y "container_count"
    Y la red "mi-app" informa "container_count" mayor que 0
    Y las redes "bridge", "host" y "none" se marcan con "is_builtin" en true

  Escenario: Creación de una red con subred propia
    Dado que el usuario crea la red "mi-app" con la subred "172.20.0.0/16"
    Cuando el frontend envía un POST a "/api/v1/networks"
    Entonces el sistema responde con código HTTP 201
    Y la red creada aparece en el inventario
    Y su subred es "172.20.0.0/16"

  Escenario: Normalización de la subred indicada
    Dado que el usuario indica la subred "172.20.0.5/16"
    Cuando el frontend envía un POST a "/api/v1/networks"
    Entonces el sistema normaliza la subred a "172.20.0.0/16"
    Y la red se crea correctamente

  Escenario: Creación con datos inválidos
    Dado que el usuario intenta crear una red con el nombre "mi red" con espacios
    Cuando el frontend envía un POST a "/api/v1/networks"
    Entonces el sistema responde con código HTTP 400
    Y la red no se crea
    Y cuando el nombre empieza por el prefijo reservado "docker_"
    Entonces el sistema responde con código HTTP 400

  Escenario: Nombre de red duplicado
    Dado que ya existe una red llamada "mi-app"
    Cuando el usuario intenta crear otra con el mismo nombre
    Entonces el sistema responde con código HTTP 409
    Y el mensaje indica que el nombre ya está en uso

  Escenario: Borrado de una red en uso
    Dado que existe la red "mi-app" con un contenedor conectado
    Cuando el usuario solicita "DELETE /api/v1/networks/mi-app" sin forzar
    Entonces el sistema responde con código HTTP 409
    Y el inventario no cambia

  Escenario: Protección de las redes predefinidas
    Dado que existe la red predefinida "bridge" con contenedores conectados
    Cuando el usuario solicita "DELETE /api/v1/networks/bridge"
    Entonces el sistema responde con código HTTP 400
    Y la red "bridge" sigue existiendo
    Y cuando el usuario solicita "POST /api/v1/networks/prune"
    Entonces la red "bridge" no aparece en la lista de eliminadas

  Escenario: Limpieza de redes no usadas
    Dado que el host tiene redes propias sin contenedores y redes en uso
    Cuando el usuario solicita "POST /api/v1/networks/prune"
    Entonces el sistema responde con código HTTP 200
    Y la respuesta lista en "deleted" solo las redes propias sin contenedores
    Y ninguna red con contenedores connected es eliminada

  Escenario: Inspección del detalle de una red
    Dado que existe la red "mi-app" con un contenedor conectado
    Cuando el usuario solicita "GET /api/v1/networks/mi-app"
    Entonces el sistema responde con código HTTP 200
    Y la respuesta incluye las subredes con su "gateway"
    Y la respuesta incluye el nombre de los contenedores conectados
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest` + `pytest-asyncio`)
- `tests/test_networks.py`:
  - `test_list_networks_marks_builtin`: `bridge`, `host` y `none` llevan `is_builtin: true`.
  - `test_list_networks_container_count`: el recuento sale del listado, sin llamadas `show()` adicionales.
  - `test_network_detail_includes_attached_containers`.
  - `test_create_network_with_subnet` y `test_create_network_without_subnet`.
  - `test_create_network_normalizes_cidr`: `172.20.0.5/16` → `172.20.0.0/16`.
  - `test_create_network_invalid_name` (espacios, vacío, `docker_` reservado, >63 caracteres).
  - `test_create_network_duplicate_returns_409`.
  - `test_delete_network_conflict` (409 sin force) y `test_delete_network_success`.
  - `test_delete_builtin_network_rejected`: 400 sin llegar a contactar con el daemon.
  - `test_prune_skips_builtin_and_in_use`.
- `tests/test_network_reference.py`: validación pura del nombre y del CIDR.

### Frontend (`vitest` + `@testing-library/react`)
- `tests/components/NetworksTable.test.tsx`: insignia de predefinida, subred formateada, recuento de contenedores y ausencia de botón de borrar en las predefinidas.
- `tests/components/NetworkDetailModal.test.tsx`: subredes con gateway, contenedores conectados, indicadores y cierre.
- `tests/components/NetworksView.test.tsx`: filtros, buscador, creación y confirmación de la limpieza.
- `tests/components/CreateNetworkModal.test.tsx`: validación de nombre y subred antes de enviar, y mensajes de error del backend.

### Verificación manual
- Crear una red con subred, conectar un contenedor, comprobar que el recuento sube y que el borrado queda bloqueado.
- Ejecutar `docker network prune` en una terminal y verificar que la limpieza del panel coincide.

---

## 6. Plan de Tareas (Tasks)

- [x] **Fase 1: Contratos**
  - [x] Crear `backend/app/schemas/network.py` con `NetworkSubnet`, `NetworkSummary`, `NetworkDetail`, `CreateNetworkRequest`, `NetworkDeleteResponse` y `NetworkPruneResult`
  - [x] Crear `frontend/src/types/network.ts` con las interfaces equivalentes campo por campo
- [x] **Fase 2: Tests Primero en Backend (TDD)**
  - [x] Añadir `FakeDockerNetworks` a `backend/tests/conftest.py` con `list`, `show`, `create` y `delete`
  - [x] Crear `backend/tests/test_network_reference.py` para la validación de nombre y CIDR
  - [x] Crear `backend/tests/test_networks.py`
  - [x] Ejecutar `pytest -v` y confirmar que falla por implementación ausente (fase roja)
- [x] **Fase 3: Implementación Backend**
  - [x] Implementar el validador de nombre de red y de subred CIDR
  - [x] Implementar `list_networks` con la marca de predefinidas y `get_network_detail`
  - [x] Implementar `create_network` con la normalización de CIDR y el mapeo de 409
  - [x] Implementar `delete_network` rechazando predefinidas antes de contactar con el daemon
  - [x] Implementar `prune_networks` limitado a las no usadas y no predefinidas
  - [x] Registrar los endpoints en `backend/app/api/v1/networks.py` e incluirlo en `api/router.py`
  - [x] Ejecutar `pytest -v` y validar aprobación al 100%
- [x] **Fase 4: Tests Primero en Frontend**
  - [x] Crear `frontend/tests/components/NetworksTable.test.tsx`
  - [x] Crear `frontend/tests/components/NetworkDetailModal.test.tsx`
  - [x] Crear `frontend/tests/components/NetworksView.test.tsx`
  - [x] Crear `frontend/tests/components/CreateNetworkModal.test.tsx`
- [x] **Fase 5: Implementación Frontend**
  - [x] Añadir `getNetworks`, `getNetwork`, `createNetwork`, `deleteNetwork` y `pruneNetworks` a `frontend/src/services/dockerApi.ts`
  - [x] Implementar `frontend/src/components/networks/NetworksTable.tsx` con la insignia de predefinida
  - [x] Implementar `frontend/src/components/networks/NetworkDetailModal.tsx`
  - [x] Implementar `frontend/src/components/networks/CreateNetworkModal.tsx` con validación en cliente
  - [x] Implementar `frontend/src/components/networks/NetworksView.tsx` con filtros, buscador y limpieza
  - [x] Añadir la quinta pestaña `Redes` al conmutador de `frontend/src/App.tsx`
- [x] **Fase 6: Verificación y Quality Gates**
  - [x] Ejecutar y aprobar la suite backend (`make backend-test`) y el lint (`make backend-lint`)
  - [x] Ejecutar y aprobar la suite frontend (`pnpm run test`, `pnpm run lint`, `pnpm run build`)
  - [x] Verificar que los tests de arquitectura de tokens y de overlays siguen pasando
  - [x] Comprobar en el host real que borrar `bridge` se rechaza y que la limpieza respeta las predefinidas
  - [x] Actualizar `agent.md` (árboles, `specs/10-networks-management.md`) y marcar las tareas como completadas (`[x]`)
