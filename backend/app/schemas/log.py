from pydantic import BaseModel, Field


class LogEntry(BaseModel):
    timestamp: str | None = None
    stream: str = "stdout"  # "stdout" | "stderr" | "system"
    message: str


class LogSnapshotResponse(BaseModel):
    id: str
    total_lines: int
    lines: list[LogEntry] = Field(default_factory=list)
