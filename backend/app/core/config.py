# SPDX-License-Identifier: AGPL-3.0-or-later
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    PROJECT_NAME: str = "DockPilot"
    VERSION: str = "0.1.0"
    API_V1_PREFIX: str = "/api/v1"
    DOCKER_SOCKET: str = "unix:///var/run/docker.sock"

    # Puerto en el que sirve el frontend. Es el unico sitio del que se derivan
    # los origenes permitidos, para que cambiar de puerto no obligue a tocar dos
    # ficheros a la vez. En desarrollo el proxy de Vite hace que las peticiones
    # nunca sean cross-origin, asi que esto solo importa al abrir `/docs` o al
    # llamar a la API desde otro origen.
    FRONTEND_PORT: int = 8182

    # Si se deja en None, se deriva de FRONTEND_PORT. Para sobreescribirlo desde
    # el entorno hay que pasarlo como JSON: pydantic-settings parsea las listas
    # como JSON, no como texto separado por comas.
    CORS_ORIGINS: list[str] | None = None

    # Raíz del explorador de archivos compose (SPEC-14). None significa el home
    # del usuario, que es lo más arriba que tiene sentido para un panel local: los
    # proyectos están ahí y salir de ahí no aporta nada. Se resuelve con
    # `os.path.expanduser` y no con un literal, porque el backend puede correr en
    # un contenedor o con otro usuario del host.
    COMPOSE_BROWSE_ROOT: str | None = None

    # Máximo de entradas por listado. Un directorio del home puede tener decenas de
    # miles de ficheros; sin tope la respuesta crece sin control. El truncado se
    # comunica en la respuesta en lugar de ocurrir en silencio.
    COMPOSE_BROWSE_MAX: int = 500

    # Tope de ficheros al medir el contexto de un `build` para poder decir cuánto
    # va a costar (SPEC-15 §2.4). En el host de referencia un contexto real se mide
    # en 0,2 s con 19 000 ficheros, así que el tope está para el caso patológico —
    # un contexto que sea un directorio del home— y no para el uso normal. Al
    # alcanzarlo el tamaño sale parcial y marcado, nunca inventado.
    COMPOSE_BUILD_ESTIMATE_MAX_FILES: int = 20000

    # Topes de la copia de ficheros de un contenedor (SPEC-20 §2.4). Docker NO
    # impone ninguno: se escribieron y leyeron ficheros de 120 MB sin
    # resistencia. El límite lo pone el panel y por razones distintas en cada
    # sentido —una subida viaja por WebSocket y por la memoria del navegador; una
    # descarga es una descarga— así que no son el mismo número.
    FILES_UPLOAD_MAX_BYTES: int = 16 * 1024 * 1024
    FILES_DOWNLOAD_MAX_BYTES: int = 64 * 1024 * 1024

    # Máximo de entradas al listar un directorio del contenedor. Sin tope, una
    # respuesta puede traer decenas de miles.
    FILES_LIST_MAX_ENTRIES: int = 2000

    model_config = SettingsConfigDict(case_sensitive=True)

    @model_validator(mode="after")
    def _derivar_origenes(self) -> "Settings":
        # Se rellena en un validador, no en el default de clase: un default
        # evaluado en el cuerpo de la clase se calcularia con el valor por
        # defecto de FRONTEND_PORT y la variable de entorno se ignoraria en
        # silencio.
        if self.CORS_ORIGINS is None:
            self.CORS_ORIGINS = [
                f"http://localhost:{self.FRONTEND_PORT}",
                f"http://127.0.0.1:{self.FRONTEND_PORT}",
            ]
        return self


settings = Settings()
