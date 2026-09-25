from typing import List
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
