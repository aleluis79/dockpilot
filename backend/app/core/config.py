from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    PROJECT_NAME: str = "DockPilot"
    VERSION: str = "0.1.0"
    API_V1_PREFIX: str = "/api/v1"
    DOCKER_SOCKET: str = "unix:///var/run/docker.sock"
    CORS_ORIGINS: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

    model_config = SettingsConfigDict(case_sensitive=True)


settings = Settings()
