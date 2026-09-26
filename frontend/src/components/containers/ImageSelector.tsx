// SPDX-License-Identifier: AGPL-3.0-or-later
import React, { useState, useEffect } from 'react'
import { Search, Star, ShieldCheck, Box, HardDrive, Sparkles, Loader2 } from 'lucide-react'
import { dockerApi } from '../../services/dockerApi'
import type { ImageSearchResult, LocalImageSummary } from '../../types/image'

interface ImageSelectorProps {
  selectedImage: string
  onSelectImage: (image: string) => void
}

const PRESETS = [
  { name: 'Nginx', image: 'nginx:alpine', desc: 'Servidor web ligero' },
  { name: 'Postgres', image: 'postgres:16-alpine', desc: 'Base de datos relacional' },
  { name: 'Redis', image: 'redis:alpine', desc: 'Caché en memoria clave-valor' },
  { name: 'Node.js', image: 'node:20-alpine', desc: 'Entorno JavaScript' },
  { name: 'Python', image: 'python:3.12-slim', desc: 'Intérprete Python' },
  { name: 'Alpine', image: 'alpine:latest', desc: 'Linux minimalista' },
]

export const ImageSelector: React.FC<ImageSelectorProps> = ({
  selectedImage,
  onSelectImage,
}) => {
  const [tab, setTab] = useState<'presets' | 'local' | 'search'>('presets')
  
  // Estado para imágenes locales
  const [localImages, setLocalImages] = useState<LocalImageSummary[]>([])
  const [loadingLocal, setLoadingLocal] = useState<boolean>(false)

  // Estado para búsqueda en Docker Hub
  const [searchTerm, setSearchTerm] = useState<string>('')
  const [searchResults, setSearchResults] = useState<ImageSearchResult[]>([])
  const [searching, setSearching] = useState<boolean>(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  // Cargar imágenes locales al cambiar a esa pestaña
  useEffect(() => {
    if (tab !== 'local' || localImages.length > 0) return

    let isMounted = true
    dockerApi
      .getLocalImages()
      .then((data) => {
        if (isMounted) {
          setLocalImages(data)
          setLoadingLocal(false)
        }
      })
      .catch(() => {
        if (isMounted) setLoadingLocal(false)
      })

    return () => {
      isMounted = false
    }
  }, [tab, localImages.length])

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!searchTerm.trim()) return

    try {
      setSearching(true)
      setSearchError(null)
      const results = await dockerApi.searchImages(searchTerm.trim(), 10)
      setSearchResults(results)
    } catch (err: unknown) {
      setSearchError(err instanceof Error ? err.message : 'Error al buscar imágenes')
    } finally {
      setSearching(false)
    }
  }

  const formatBytes = (bytes: number) => {
    if (!bytes) return '0 B'
    const mb = bytes / (1024 * 1024)
    if (mb > 1024) return `${(mb / 1024).toFixed(1)} GB`
    return `${mb.toFixed(1)} MB`
  }

  return (
    <div className="space-y-3">
      {/* Selector de Pestañas */}
      <div className="flex items-center gap-1 p-1 bg-inset rounded-xl border border-default text-xs">
        <button
          type="button"
          onClick={() => setTab('presets')}
          className={`flex-1 py-1.5 px-3 rounded-lg font-medium transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
            tab === 'presets'
              ? 'bg-elevated text-fg shadow-sm'
              : 'text-fg-muted hover:text-fg'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5 text-amber-700 dark:text-amber-400" />
          <span>Plantillas</span>
        </button>

        <button
          type="button"
          onClick={() => setTab('local')}
          className={`flex-1 py-1.5 px-3 rounded-lg font-medium transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
            tab === 'local'
              ? 'bg-elevated text-fg shadow-sm'
              : 'text-fg-muted hover:text-fg'
          }`}
        >
          <HardDrive className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
          <span>Locales</span>
        </button>

        <button
          type="button"
          onClick={() => setTab('search')}
          className={`flex-1 py-1.5 px-3 rounded-lg font-medium transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
            tab === 'search'
              ? 'bg-elevated text-fg shadow-sm'
              : 'text-fg-muted hover:text-fg'
          }`}
        >
          <Search className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
          <span>Docker Hub</span>
        </button>
      </div>

      {/* Contenido Pestaña 1: Presets Rápidos */}
      {tab === 'presets' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {PRESETS.map((p) => {
            const isSelected = selectedImage === p.image
            return (
              <button
                key={p.image}
                type="button"
                onClick={() => onSelectImage(p.image)}
                className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-blue-600/15 border-blue-500/50 text-blue-800 dark:text-blue-200'
                    : 'bg-inset border-default hover:border-strong text-fg'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-xs text-fg">{p.name}</span>
                  {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />}
                </div>
                <div className="font-mono text-[11px] text-fg-muted truncate mt-0.5">{p.image}</div>
              </button>
            )
          })}
        </div>
      )}

      {/* Contenido Pestaña 2: Imágenes Locales */}
      {tab === 'local' && (
        <div className="space-y-2">
          {loadingLocal ? (
            <div className="p-6 text-center text-xs text-fg-muted flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-blue-600 dark:text-blue-500" />
              <span>Cargando imágenes del host...</span>
            </div>
          ) : localImages.length === 0 ? (
            <div className="p-4 bg-inset border border-default rounded-xl text-center text-xs text-fg-muted">
              No hay imágenes locales descargadas en el daemon.
            </div>
          ) : (
            <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1">
              {localImages.flatMap((img) =>
                img.tags.map((tag) => {
                  const isSelected = selectedImage === tag
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => onSelectImage(tag)}
                      className={`w-full p-2 rounded-xl border text-left text-xs transition-all flex items-center justify-between cursor-pointer ${
                        isSelected
                          ? 'bg-blue-600/15 border-blue-500/50 text-blue-800 dark:text-blue-200'
                          : 'bg-inset border-default/80 hover:bg-fg/10 text-fg'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <Box className="w-3.5 h-3.5 text-fg-muted shrink-0" />
                        <span className="font-mono truncate">{tag}</span>
                      </div>
                      <span className="text-[11px] text-fg-muted shrink-0">
                        {formatBytes(img.size)}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          )}
        </div>
      )}

      {/* Contenido Pestaña 3: Búsqueda en Docker Hub */}
      {tab === 'search' && (
        <div className="space-y-2.5">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-fg-muted absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Buscar imagen en Docker Hub (ej. redis, mongo)..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    e.stopPropagation()
                    handleSearch()
                  }
                }}
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-inset border border-default rounded-xl text-fg placeholder-fg-muted focus:outline-none focus:border-blue-500/50"
              />
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                handleSearch()
              }}
              disabled={searching || !searchTerm.trim()}
              className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              {searching ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <span>Buscar</span>
              )}
            </button>
          </div>

          {searchError && (
            <div className="p-2.5 bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-400 text-xs rounded-xl">
              {searchError}
            </div>
          )}

          {searchResults.length > 0 && (
            <div className="max-h-44 overflow-y-auto space-y-1.5 pr-1">
              {searchResults.map((res) => {
                const isSelected = selectedImage === res.name || selectedImage.startsWith(`${res.name}:`)
                return (
                  <button
                    key={res.name}
                    type="button"
                    onClick={() => onSelectImage(res.name.includes(':') ? res.name : `${res.name}:latest`)}
                    className={`w-full p-2.5 rounded-xl border text-left text-xs transition-all flex flex-col gap-1 cursor-pointer ${
                      isSelected
                        ? 'bg-blue-600/15 border-blue-500/50 text-blue-800 dark:text-blue-200'
                        : 'bg-inset border-default hover:bg-fg/10 text-fg'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 font-mono font-medium text-fg">
                        <span>{res.name}</span>
                        {res.is_official && (
                          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[10px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 font-sans">
                            <ShieldCheck className="w-3 h-3" />
                            Oficial
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-[11px] text-fg-muted">
                        <Star className="w-3 h-3 text-amber-700 dark:text-amber-400 fill-amber-400" />
                        <span>{res.star_count.toLocaleString()}</span>
                      </div>
                    </div>
                    {res.description && (
                      <p className="text-[11px] text-fg-muted line-clamp-1">{res.description}</p>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
