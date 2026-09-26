# SPDX-License-Identifier: AGPL-3.0-or-later
"""Validación de la referencia de imagen en el borde (SPEC-07 §3.2)."""

import pytest

from app.services.image_service import normalize_image_ref, validate_image_ref


class TestValidReferences:
    @pytest.mark.parametrize(
        "ref",
        [
            "nginx",
            "nginx:alpine",
            "library/redis:7",
            "ghcr.io/propietario/app:1.2",
            "docker.io/library/postgres:16-alpine",
            "mi-imagen-con-guiones-y_underscores:v1",
            "localhost:5000/mi-app:dev",
            "registry.example.com:5000/equipo/app:1.2",
            "ubuntu@sha256:" + "a" * 64,
            "nginx:alpine@sha256:" + "b" * 64,
        ],
    )
    def test_acepta_referencias_validas(self, ref: str):
        assert validate_image_ref(ref) is None

    def test_acepta_una_imagen_solo_con_digest(self):
        ref = "alpine@sha256:" + "c" * 64
        assert validate_image_ref(ref) is None


class TestInvalidReferences:
    @pytest.mark.parametrize(
        "ref, motivo",
        [
            ("", "referencia vacía"),
            ("   ", "solo espacios"),
            ("nginx alpine", "espacios en medio"),
            ("nginx/alpine/../etc", "segmentos no permitidos por el patrón"),
            ("nginx//alpine", "segmento vacío"),
            ("nginx/alpine/", "barra final"),
            ("nginx@sha256:xyz", "digest no hexadecimal"),
            ("nginx@sha256:" + "a" * 63, "digest demasiado corto"),
            ("nginx@md5:" + "a" * 32, "algoritmo distinto de sha256"),
            ("-nginx", "no puede empezar por guion"),
            ("nginx:", "tag vacío"),
            ("a" * 300, "supera los 255 caracteres"),
        ],
    )
    def test_rechaza_referencias_invalidas(self, ref: str, motivo: str):
        with pytest.raises(ValueError) as exc:
            validate_image_ref(ref)
        assert str(exc.value), f"el error debe explicarse ({motivo})"


class TestNormalize:
    def test_sin_tag_embebido_usa_latest(self):
        assert normalize_image_ref("nginx") == "nginx:latest"

    def test_conserva_el_tag_ya_embebido(self):
        assert normalize_image_ref("nginx:alpine") == "nginx:alpine"

    def test_conserva_el_digest(self):
        ref = "alpine@sha256:" + "d" * 64
        assert normalize_image_ref(ref) == ref

    def test_espacios_al_redondeo_se_recortan(self):
        assert normalize_image_ref("  nginx:alpine  ") == "nginx:alpine"
