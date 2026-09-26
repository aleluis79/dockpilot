// SPDX-License-Identifier: AGPL-3.0-or-later
import React, { useState } from 'react'
import { X, Network as NetworkIcon, Loader2, AlertCircle } from 'lucide-react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import type { CreateNetworkRequest, NetworkDetail } from '../../types/network'

interface CreateNetworkModalProps {
  onClose: () => void
  /** Lo aporta la vista, que es quien refresca el inventario al terminar. */
  onCreate: (payload: CreateNetworkRequest) => Promise<NetworkDetail>
  onCreated: (network: NetworkDetail) => void
}

export const CreateNetworkModal: React.FC<CreateNetworkModalProps> = ({
  onClose,
  onCreate,
  onCreated,
}) => {
  const [name, setName] = useState<string>('')
  const [subnet, setSubnet] = useState<string>('')
  const [gateway, setGateway] = useState<string>('')
  const [internal, setInternal] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<boolean>(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!name.trim()) {
      setError('El nombre de la red es obligatorio')
      return
    }
    if (gateway.trim() && !subnet.trim()) {
      setError('La puerta de enlace necesita una subred: indica el CIDR primero')
      return
    }

    setSaving(true)
    try {
      const created = await onCreate({
        name: name.trim(),
        driver: 'bridge',
        subnet: subnet.trim() || null,
        gateway: gateway.trim() || null,
        internal,
        labels: {},
      })
      onCreated(created)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al crear la red')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={MODAL_OVERLAY} onClick={onClose}>
      <div
        className="bg-card border border-default rounded-lg w-full max-w-md shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Crear red"
      >
        <div className="flex items-center justify-between p-4 border-b border-default">
          <div className="flex items-center gap-2">
            <NetworkIcon className="w-4.5 h-4.5 text-accent" />
            <h3 className="text-sm font-semibold text-fg">Crear red</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-fg-subtle hover:text-fg hover:bg-elevated-hover transition-colors"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          <div>
            <label
              htmlFor="network-name"
              className="block text-xs font-medium text-fg-subtle mb-1"
            >
              Nombre de la red
            </label>
            <input
              id="network-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="mi-red"
              className="w-full px-2.5 py-1.5 text-sm rounded bg-elevated text-fg border border-default focus:border-accent outline-none font-mono"
            />
          </div>

          <div>
            <label
              htmlFor="network-subnet"
              className="block text-xs font-medium text-fg-subtle mb-1"
            >
              Subred (CIDR)
            </label>
            <input
              id="network-subnet"
              value={subnet}
              onChange={(e) => setSubnet(e.target.value)}
              placeholder="172.20.0.0/16"
              className="w-full px-2.5 py-1.5 text-sm rounded bg-elevated text-fg border border-default focus:border-accent outline-none font-mono"
            />
            <p className="text-[11px] text-fg-subtle mt-1">
              Opcional. Si se omite, Docker asigna la siguiente subred libre, que es lo
              habitual.
            </p>
          </div>

          <div>
            <label
              htmlFor="network-gateway"
              className="block text-xs font-medium text-fg-subtle mb-1"
            >
              Puerta de enlace
            </label>
            <input
              id="network-gateway"
              value={gateway}
              onChange={(e) => setGateway(e.target.value)}
              placeholder="172.20.0.1"
              disabled={!subnet.trim()}
              className="w-full px-2.5 py-1.5 text-sm rounded bg-elevated text-fg border border-default focus:border-accent outline-none font-mono disabled:opacity-50"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-fg cursor-pointer">
            <input
              type="checkbox"
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
              className="w-4 h-4 rounded accent-[var(--color-accent)]"
            />
            Red interna (sin salida a internet)
          </label>

          {error && (
            <div role="alert" className="flex items-start gap-2 p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-700 dark:text-red-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded text-fg-subtle hover:text-fg hover:bg-elevated-hover transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-1.5"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Crear
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
