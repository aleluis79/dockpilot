import React, { useState, useEffect } from 'react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { X, Plus, Trash2, Box, Network, Tag, HardDrive, Loader2, Sparkles } from 'lucide-react'
import { dockerApi } from '../../services/dockerApi'
import type {
  PortBindingConfig,
  VolumeBindingConfig,
  CreateContainerRequest,
} from '../../types/docker'
import { ImageSelector } from './ImageSelector'

interface CreateContainerModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
  /** Referencia de imagen preseleccionada (SPEC-07: acción "Ejecutar" del inventario). */
  initialImage?: string
}

export const CreateContainerModal: React.FC<CreateContainerModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  initialImage,
}) => {
  const [image, setImage] = useState<string>(initialImage ?? '')
  const [name, setName] = useState<string>('')
  const [command, setCommand] = useState<string>('')
  const [restartPolicy, setRestartPolicy] = useState<'no' | 'always' | 'unless-stopped' | 'on-failure'>('no')
  const [startNow, setStartNow] = useState<boolean>(true)

  // Listas dinámicas
  const [ports, setPorts] = useState<PortBindingConfig[]>([])
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([])
  const [volumes, setVolumes] = useState<VolumeBindingConfig[]>([])

  // Estado de carga y error
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  // Preseleccionar la imagen cuando se abre el modal con una referencia
  useEffect(() => {
    if (isOpen && initialImage) setImage(initialImage)
  }, [isOpen, initialImage])

  // Cerrar al pulsar Escape
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  // Helpers para agregar/quitar puertos
  const addPort = () => {
    setPorts((prev) => [...prev, { host_port: 8080, container_port: 80, protocol: 'tcp' }])
  }
  const removePort = (idx: number) => {
    setPorts((prev) => prev.filter((_, i) => i !== idx))
  }
  const updatePort = (idx: number, field: keyof PortBindingConfig, val: unknown) => {
    setPorts((prev) =>
      prev.map((p, i) => (i === idx ? { ...p, [field]: val } : p))
    )
  }

  // Helpers para agregar/quitar variables de entorno
  const addEnv = () => {
    setEnvVars((prev) => [...prev, { key: '', value: '' }])
  }
  const removeEnv = (idx: number) => {
    setEnvVars((prev) => prev.filter((_, i) => i !== idx))
  }
  const updateEnv = (idx: number, field: 'key' | 'value', val: string) => {
    setEnvVars((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, [field]: val } : item))
    )
  }

  // Helpers para agregar/quitar volúmenes
  const addVolume = () => {
    setVolumes((prev) => [...prev, { host_path: '', container_path: '', mode: 'rw' }])
  }
  const removeVolume = (idx: number) => {
    setVolumes((prev) => prev.filter((_, i) => i !== idx))
  }
  const updateVolume = (idx: number, field: keyof VolumeBindingConfig, val: string) => {
    setVolumes((prev) =>
      prev.map((v, i) => (i === idx ? { ...v, [field]: val } : v))
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!image.trim()) {
      setError('Debes especificar una imagen de Docker')
      return
    }

    try {
      setLoading(true)
      setError(null)

      // Transformar envVars en Record<string, string>
      const envRecord: Record<string, string> = {}
      for (const item of envVars) {
        if (item.key.trim()) {
          envRecord[item.key.trim()] = item.value
        }
      }

      const payload: CreateContainerRequest = {
        image: image.trim(),
        name: name.trim() || undefined,
        ports: ports.map((p) => ({
          host_port: Number(p.host_port),
          container_port: Number(p.container_port),
          protocol: p.protocol,
        })),
        env: envRecord,
        volumes: volumes.filter((v) => v.host_path.trim() && v.container_path.trim()),
        command: command.trim() || undefined,
        restart_policy: restartPolicy,
        start_now: startNow,
      }

      await dockerApi.createContainer(payload)
      onSuccess()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al crear contenedor')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className={`${MODAL_OVERLAY} p-3 sm:p-6 overflow-hidden`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[90vh] min-h-0 flex flex-col bg-surface border border-default rounded-2xl shadow-2xl overflow-hidden font-sans"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between p-5 border-b border-default bg-surface/90">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-xl border border-blue-500/20">
              <Box className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-fg">Crear Nuevo Contenedor</h2>
              <p className="text-xs text-fg-muted">Configura y despliega un servicio Docker en tu máquina local</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-fg-muted hover:text-fg hover:bg-fg/10 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Formulario */}
        <form onSubmit={handleSubmit} className="flex-1 min-h-0 overflow-y-auto p-6 space-y-6 text-sm text-fg">
          {error && (
            <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-400 text-xs rounded-xl">
              {error}
            </div>
          )}

          {/* Sección 1: Selección de Imagen */}
          <div className="space-y-3">
            <label className="text-xs font-semibold uppercase tracking-wider text-fg-muted flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
              <span>Imagen Docker *</span>
            </label>

            {/* Selector interactivo con tabs */}
            <ImageSelector
              selectedImage={image}
              onSelectImage={(selected) => setImage(selected)}
            />

            {/* Input manual de imagen */}
            <div>
              <input
                type="text"
                placeholder="ej. nginx:alpine o redis:latest"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                className="w-full px-3.5 py-2 text-xs font-mono bg-inset border border-default rounded-xl text-fg placeholder-fg-muted focus:outline-none focus:border-blue-500/50"
                required
              />
              <p className="text-[11px] text-fg-muted mt-1">
                Puedes escribir la imagen manualmente o elegirla desde las plantillas / búsqueda superior.
              </p>
            </div>
          </div>

          {/* Sección 2: Configuración Básica */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-fg-muted block mb-1.5">
                Nombre del Contenedor
              </label>
              <input
                type="text"
                placeholder="ej. mi-contenedor (opcional)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3.5 py-2 text-xs bg-inset border border-default rounded-xl text-fg placeholder-fg-muted focus:outline-none focus:border-blue-500/50"
              />
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-fg-muted block mb-1.5">
                Política de Reinicio
              </label>
              <select
                value={restartPolicy}
                onChange={(e) => setRestartPolicy(e.target.value as any)}
                className="w-full px-3.5 py-2 text-xs bg-inset border border-default rounded-xl text-fg focus:outline-none focus:border-blue-500/50 cursor-pointer"
              >
                <option value="no">No reiniciar (no)</option>
                <option value="always">Siempre (always)</option>
                <option value="unless-stopped">A menos que se detenga (unless-stopped)</option>
                <option value="on-failure">Al fallar (on-failure)</option>
              </select>
            </div>
          </div>

          {/* Comando personalizado */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-fg-muted block mb-1.5">
              Comando (CMD Override)
            </label>
            <input
              type="text"
              placeholder="ej. npm start o redis-server --appendonly yes"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="w-full px-3.5 py-2 text-xs font-mono bg-inset border border-default rounded-xl text-fg placeholder-fg-muted focus:outline-none focus:border-blue-500/50"
            />
          </div>

          {/* Sección 3: Mapeo de Puertos */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold uppercase tracking-wider text-fg-muted flex items-center gap-1.5">
                <Network className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                <span>Mapeo de Puertos</span>
              </label>
              <button
                type="button"
                onClick={addPort}
                className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 font-medium flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Añadir puerto</span>
              </button>
            </div>

            {ports.length === 0 ? (
              <p className="text-xs text-fg-subtle italic">Sin puertos expuestos.</p>
            ) : (
              <div className="space-y-2">
                {ports.map((p, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="number"
                      placeholder="Host (ej. 8080)"
                      value={p.host_port}
                      onChange={(e) => updatePort(idx, 'host_port', e.target.value)}
                      className="w-32 px-3 py-1.5 text-xs font-mono bg-inset border border-default rounded-lg text-fg focus:outline-none focus:border-blue-500/50"
                      required
                    />
                    <span className="text-fg-subtle text-xs">➔</span>
                    <input
                      type="number"
                      placeholder="Contenedor (ej. 80)"
                      value={p.container_port}
                      onChange={(e) => updatePort(idx, 'container_port', e.target.value)}
                      className="w-32 px-3 py-1.5 text-xs font-mono bg-inset border border-default rounded-lg text-fg focus:outline-none focus:border-blue-500/50"
                      required
                    />
                    <select
                      value={p.protocol}
                      onChange={(e) => updatePort(idx, 'protocol', e.target.value)}
                      className="px-2.5 py-1.5 text-xs bg-inset border border-default rounded-lg text-fg focus:outline-none focus:border-blue-500/50 cursor-pointer"
                    >
                      <option value="tcp">TCP</option>
                      <option value="udp">UDP</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => removePort(idx)}
                      title="Eliminar puerto"
                      className="p-1.5 text-fg-muted hover:text-rose-700 dark:hover:text-rose-400 rounded-lg transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Sección 4: Variables de Entorno */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold uppercase tracking-wider text-fg-muted flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5 text-purple-700 dark:text-purple-400" />
                <span>Variables de Entorno</span>
              </label>
              <button
                type="button"
                onClick={addEnv}
                className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 font-medium flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Añadir variable</span>
              </button>
            </div>

            {envVars.length === 0 ? (
              <p className="text-xs text-fg-subtle italic">Sin variables de entorno adicionales.</p>
            ) : (
              <div className="space-y-2">
                {envVars.map((env, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="CLAVE (ej. POSTGRES_PASSWORD)"
                      value={env.key}
                      onChange={(e) => updateEnv(idx, 'key', e.target.value)}
                      className="flex-1 px-3 py-1.5 text-xs font-mono bg-inset border border-default rounded-lg text-fg focus:outline-none focus:border-blue-500/50"
                    />
                    <span className="text-fg-subtle text-xs">=</span>
                    <input
                      type="text"
                      placeholder="Valor"
                      value={env.value}
                      onChange={(e) => updateEnv(idx, 'value', e.target.value)}
                      className="flex-1 px-3 py-1.5 text-xs font-mono bg-inset border border-default rounded-lg text-fg focus:outline-none focus:border-blue-500/50"
                    />
                    <button
                      type="button"
                      onClick={() => removeEnv(idx)}
                      title="Eliminar variable"
                      className="p-1.5 text-fg-muted hover:text-rose-700 dark:hover:text-rose-400 rounded-lg transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Sección 5: Volúmenes */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold uppercase tracking-wider text-fg-muted flex items-center gap-1.5">
                <HardDrive className="w-3.5 h-3.5 text-amber-700 dark:text-amber-400" />
                <span>Montajes de Volúmenes</span>
              </label>
              <button
                type="button"
                onClick={addVolume}
                className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 font-medium flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Añadir montaje</span>
              </button>
            </div>

            {volumes.length === 0 ? (
              <p className="text-xs text-fg-subtle italic">Sin montajes de volúmenes.</p>
            ) : (
              <div className="space-y-2">
                {volumes.map((v, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Ruta en Host (/home/user/data)"
                      value={v.host_path}
                      onChange={(e) => updateVolume(idx, 'host_path', e.target.value)}
                      className="flex-1 px-3 py-1.5 text-xs font-mono bg-inset border border-default rounded-lg text-fg focus:outline-none focus:border-blue-500/50"
                    />
                    <span className="text-fg-subtle text-xs">➔</span>
                    <input
                      type="text"
                      placeholder="Ruta Contenedor (/app/data)"
                      value={v.container_path}
                      onChange={(e) => updateVolume(idx, 'container_path', e.target.value)}
                      className="flex-1 px-3 py-1.5 text-xs font-mono bg-inset border border-default rounded-lg text-fg focus:outline-none focus:border-blue-500/50"
                    />
                    <button
                      type="button"
                      onClick={() => removeVolume(idx)}
                      title="Eliminar montaje"
                      className="p-1.5 text-fg-muted hover:text-rose-700 dark:hover:text-rose-400 rounded-lg transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Opción Iniciar Inmediatamente */}
          <div className="pt-2 border-t border-default">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={startNow}
                onChange={(e) => setStartNow(e.target.checked)}
                className="w-4 h-4 rounded border-strong bg-elevated text-blue-600 focus:ring-blue-500/30"
              />
              <span className="text-xs text-fg font-medium">
                Iniciar el contenedor inmediatamente tras crearlo (<code className="font-mono text-blue-600 dark:text-blue-400">docker run</code>)
              </span>
            </label>
          </div>
        </form>

        {/* Footer */}
        <div className="shrink-0 p-4 border-t border-default bg-surface/90 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 text-xs font-medium text-fg hover:text-fg bg-elevated hover:bg-fg/10 rounded-xl transition-colors cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading || !image.trim()}
            className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-xl transition-colors flex items-center gap-2 cursor-pointer shadow-lg shadow-blue-500/20"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Descargando y Creando...</span>
              </>
            ) : (
              <>
                <Plus className="w-4 h-4" />
                <span>Crear Contenedor</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
