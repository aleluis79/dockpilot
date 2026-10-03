// SPDX-License-Identifier: AGPL-3.0-or-later
import React from 'react'
import { Broom, AlertTriangle, X } from 'lucide-react'

import { MODAL_OVERLAY } from './modalOverlay'

interface PruneDialogProps {
  titulo: string;
  /** Frase con el recuento. Recibe los bytes ya formateados y la palabra «hasta». */
  resumen: string;
  /** Los nombres de lo que se va, si los hay. Sin ellos no se puede decidir. */
  nombres?: string[];
  /** Aviso específico del nivel: qué no se puede recuperar. */
  aviso?: React.ReactNode;
  etiquetaConfirmar: string;
  /** El nivel agresivo no comparte aspecto con el seguro (SPEC-21 §4.3). */
  destructivo?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  ocupado?: boolean;
}

/**
 * El diálogo de confirmación de una limpieza (SPEC-21 §4.6).
 *
 * Es **uno solo** para los tres niveles, y no por ahorrar código: los cuatro
 * endpoints de limpieza enseñan el mismo tipo de pregunta («esto es lo que se va
 * y esto es lo que no se puede recuperar») y un diálogo por pregunta obliga a
 * mantenerlos sincronizados a mano.
 *
 * Y hay cuatro cosas que tiene que decir, en este orden, porque decidir sin
 * ellas es decidir a ciegas:
 *
 * 1. **Cuántos** y **hasta** cuántos bytes. Nunca una cifra exacta: el preaviso
 *    suma los tamaños y las capas compartidas se cuentan dos veces.
 * 2. **Los nombres**, que es lo único que permite reconocer lo que se va.
 * 3. **Qué no se puede recuperar**, si el nivel lo tiene.
 * 4. Que **lo que está en uso no se toca**, que es la garantía que da el daemon.
 */
export const PruneDialog: React.FC<PruneDialogProps> = ({
  titulo,
  resumen,
  nombres,
  aviso,
  etiquetaConfirmar,
  destructivo = false,
  onConfirm,
  onClose,
  ocupado = false,
}) => (
  <div className={MODAL_OVERLAY} onClick={onClose}>
    <div
      className="bg-surface border border-default rounded-lg w-full max-w-md p-4 shadow-xl max-h-[85vh] flex flex-col"
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label={titulo}
    >
      <div className="flex items-start gap-3">
        <Broom
          className={`w-5 h-5 shrink-0 mt-0.5 ${destructivo ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600'}`}
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-fg">{titulo}</h3>
          <p className="text-xs text-fg-muted mt-1">{resumen}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar"
          className="text-fg-muted hover:text-fg cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {nombres && nombres.length > 0 && (
        <div className="mt-3 p-2 bg-inset border border-default rounded-xl max-h-32 overflow-y-auto">
          <span className="text-[10px] uppercase tracking-wider text-fg-subtle block mb-1">
            Se eliminan
          </span>
          <ul className="space-y-0.5">
            {nombres.map((n) => (
              <li key={n} className="font-mono text-[11px] text-fg break-all">
                {n}
              </li>
            ))}
          </ul>
        </div>
      )}

      {aviso && (
        <div className="mt-3 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-700 dark:text-rose-400 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{aviso}</span>
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-sm rounded text-fg-muted hover:text-fg hover:bg-elevated-hover transition-colors cursor-pointer"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={ocupado}
          data-nivel={destructivo ? 'agresivo' : 'seguro'}
          className={`px-3 py-1.5 text-sm rounded text-white transition-opacity disabled:opacity-50 cursor-pointer ${
            destructivo ? 'bg-rose-600 hover:bg-rose-500' : 'bg-amber-600 hover:opacity-90'
          }`}
        >
          {ocupado ? 'Limpiando...' : etiquetaConfirmar}
        </button>
      </div>
    </div>
  </div>
)
