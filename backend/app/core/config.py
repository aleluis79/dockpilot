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
