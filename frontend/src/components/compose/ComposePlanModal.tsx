// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react'
import {
  X,
  AlertTriangle,
  Rocket,
  RefreshCw,
  CheckCircle2,
  FolderSearch,
  Hammer,
  ExternalLink,
  Terminal,
} from 'lucide-react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { dockerApi } from '../../services/dockerApi'
import { ComposeEditor } from './ComposeEditor'
import { ComposeFilePicker } from './ComposeFilePicker'
import { ComposeDeployDialog } from './ComposeDeployDialog'
import { ComposeActionPanel } from './ComposeActionPanel'
import type { ComposePlan, PlannedMount, PlannedPort, PlannedService } from '../../types/compose'

interface ComposePlanModalProps {
  open: boolean
  onClose: () => void
  /** Ruta sugerida, por ejemplo la del proyecto abierto. */
  initialPath?: string
  /**
   * Recarga el inventario de proyectos.
   *
   * Sin esto, desplegar desde el plan dejaba la tabla de «Proyectos» obsoleta:
   * el proyecto recién arrancado ya tiene etiquetas y existe, pero no se veía
   * hasta cambiar de pestaña (SPEC-15 §3.8).
   */
  onRefrescar?: () => void
}

function Puertos({ ports }: { ports: PlannedPort[] }) {
  if (ports.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {ports.map((port, index) => (
        <span
          key={`${port.target}-${index}`}
          title={`Puerto ${port.target} del contenedor`}
          className="px-1.5 py-0.5 rounded bg-elevated-hover text-[10px] font-mono text-fg-muted"
        >
          {port.published ? `${port.published}:${port.target}` : port.target}
          <span className="text-fg-subtle">/{port.protocol}</span>
        </span>
      ))}
    </div>
  )
}

function Montajes({ mounts }: { mounts: PlannedMount[] }) {
  if (mounts.length === 0) return null
  return (
    <div className="mt-1 space-y-0.5">
      {mounts.map((mount, index) => (
        <div
          key={`${mount.target}-${index}`}
          className="text-[10px] font-mono text-fg-muted truncate"
          title={`${mount.type}: ${mount.source} → ${mount.target}`}
        >
          <span className="text-fg-subtle">{mount.type}</span> {mount.source} →{' '}
          {mount.target}
          {mount.read_only && <span className="text-fg-subtle"> (solo lectura)</span>}
        </div>
      ))}
    </div>
  )
}

function TarjetaServicio({ service }: { service: PlannedService }) {
  return (
    <li
      data-testid={`service-${service.name}`}
      className="p-2.5 rounded-lg border border-default bg-elevated"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-fg font-mono text-xs">{service.name}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          {service.build && (
            <span
              title="Declara una sección build: esa imagen habría que construirla"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20 text-[10px] font-semibold"
            >
              <Hammer className="w-3 h-3" />
              build
            </span>
          )}
          {service.profiles.length > 0 && (
            <span
              title={`Solo con estos perfiles activos: ${service.profiles.join(', ')}`}
              className="px-1.5 py-0.5 rounded bg-elevated-hover text-fg-subtle border border-default text-[10px] font-mono"
            >
              perfil: {service.profiles.join(', ')}
            </span>
          )}
        </div>
      </div>

      {service.image && (
        <div className="text-[11px] text-fg-subtle font-mono truncate mt-0.5">
          {service.image}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[10px] text-fg-subtle">
        {service.restart && <span>restart: {service.restart}</span>}
        {service.environment_count > 0 && (
          <span
            title="Compose declara el nombre y el valor; el panel solo muestra cuántos hay, nunca sus valores"
            className="inline-flex items-center gap-1"
          >
            {service.environment_count} variable
            {service.environment_count === 1 ? '' : 's'} de entorno
          </span>
        )}
        {service.depends_on.length > 0 && (
          <span>espera a: {service.depends_on.join(', ')}</span>
        )}
        {service.networks.length > 0 && (
          <span>redes: {service.networks.join(', ')}</span>
        )}
      </div>

      <Puertos ports={service.ports} />
      <Montajes mounts={service.mounts} />
    </li>
  )
}

function Recurso({
  testId,
  logico,
  nombre,
  subtitulo,
  existe,
  externo,
}: {
  testId: string
  logico: string
  nombre: string
  subtitulo: string
  existe: boolean
  externo: boolean
}) {
  return (
    <li data-testid={testId} className="flex items-start justify-between gap-2">
      <span className="min-w-0">
        <span className="font-mono text-fg text-[11px] truncate block">{nombre}</span>
        {logico && logico !== nombre && (
          <span className="text-[10px] text-fg-subtle font-mono block truncate">
            en el archivo: {logico}
          </span>
        )}
        <span className="text-[10px] text-fg-subtle">{subtitulo}</span>
      </span>
      <span className="shrink-0">
        {externo ? (
          <span
            title="Declarada como externa: compose no la va a crear"
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-elevated text-fg-subtle border border-default text-[10px]"
          >
            <ExternalLink className="w-3 h-3" />
            externa
          </span>
        ) : existe ? (
          <span
            title="Ya existe en el host con ese nombre"
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 text-[10px]"
          >
            <CheckCircle2 className="w-3 h-3" />
            ya existe
          </span>
        ) : (
          <span
            title="No existe todavía: se crearía"
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 text-[10px]"
          >
            se crearía
          </span>
        )}
      </span>
    </li>
  )
}

/**
 * Previsualización de un archivo compose.
 *
 * **No ejecuta nada.** Solo llama a `config`, que resuelve el archivo sin tocar
 * el host. No hay ningún botón de `up`, `down` ni `build`: si algún día lo hay,
 * el alcance ha cambiado y la spec también (SPEC-12 §1).
 */
export function ComposePlanModal({
  open,
  onClose,
  initialPath = '',
  onRefrescar,
}: ComposePlanModalProps) {
  const [path, setPath] = useState<string>(initialPath)
  const [content, setContent] = useState<string>('')
  const [plan, setPlan] = useState<ComposePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [eligiendo, setEligiendo] = useState<boolean>(false)
  const [pidiendoCoste, setPidiendoCoste] = useState<boolean>(false)
  const [desplegando, setDesplegando] = useState<boolean>(false)

  // El editor guarda su propio texto, y el despliegue usa el archivo del disco:
  // sin esta diferencia, se desplegaría algo que no está guardado (SPEC-15 §3.7).
  const sinGuardar = content.trim() !== ''
  const bloqueadoPorColision = Boolean(plan?.proyecto_en_uso && !plan.proyecto_en_uso.mismo_archivo)

  if (!open) return null

  const validar = async (conCambios: boolean) => {
    if (!path.trim()) {
      setError('Indica la ruta del archivo compose que quieres previsualizar.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const resultado = await dockerApi.planCompose({
        path: path.trim(),
        content: conCambios ? content : null,
      })
      setPlan(resultado)
    } catch (err: unknown) {
      // Sin plan si compose no pudo resolver el archivo: un plan a medias sería
      // peor que ninguno.
      setPlan(null)
      setError(err instanceof Error ? err.message : 'No se pudo previsualizar el archivo')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={MODAL_OVERLAY} onClick={onClose}>
      <div
        className="bg-surface border border-default rounded-lg w-full max-w-5xl max-h-[92vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Previsualizar archivo compose"
        data-testid="compose-plan-modal"
      >
        <div className="flex items-center justify-between p-4 border-b border-default shrink-0">
          <h3 className="text-sm font-semibold text-fg">Previsualizar compose</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="p-1 rounded text-fg-subtle hover:text-fg hover:bg-elevated-hover transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto flex-1">
          <div className="flex flex-col sm:flex-row sm:items-end gap-2">
            <div className="flex-1 min-w-0">
              <label
                htmlFor="compose-path"
                className="block text-xs font-semibold text-fg mb-1"
              >
                Ruta del archivo
              </label>
              <input
                id="compose-path"
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/home/usuario/proyectos/mi-app/docker-compose.yml"
                spellCheck={false}
                className="w-full px-2.5 py-1.5 text-xs font-mono bg-inset border border-default rounded-lg text-fg placeholder-fg-subtle focus:outline-none focus:border-blue-500/50"
              />
            </div>
            <button
              type="button"
              onClick={() => setEligiendo(true)}
              title="Explorar el disco y elegir el archivo"
              className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-inset border border-default rounded-lg text-fg-muted hover:text-fg hover:bg-elevated-hover transition-colors"
            >
              <FolderSearch className="w-3.5 h-3.5" />
              Seleccionar archivo
            </button>
            <div className="flex gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void validar(false)}
                disabled={loading}
                className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {loading && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                Validar
              </button>
              <button
                type="button"
                onClick={() => void validar(true)}
                disabled={loading || content.trim() === ''}
                title={content.trim() === '' ? 'Escribe o pega un contenido primero' : undefined}
                className="px-3 py-1.5 text-xs rounded-lg bg-elevated text-fg hover:bg-elevated-hover transition-colors disabled:opacity-50"
              >
                Validar con cambios
              </button>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-300 text-xs"
            >
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ComposeEditor value={content} onChange={setContent} />

            <div className="min-w-0">
              {plan ? (
                <div className="space-y-4" data-testid="compose-plan">
                  {plan.proyecto_en_uso && !plan.proyecto_en_uso.mismo_archivo && (
                    <p
                      data-testid="compose-colision"
                      className="text-xs text-red-400 border border-red-500/30 bg-red-500/5 rounded-lg p-2.5 leading-relaxed"
                    >
                      <AlertTriangle className="w-3.5 h-3.5 inline mr-1 align-[-2px]" />
                      Ya existe un proyecto llamado{' '}
                      <strong className="font-mono">{plan.proyecto_en_uso.nombre}</strong> que
                      viene de otro archivo (
                      <span className="font-mono">
                        {plan.proyecto_en_uso.config_files.join(', ')}
                      </span>
                      ). No se puede desplegar este: los dos archivos pelearían por el
                      mismo nombre, y <code className="font-mono">container_name</code>{' '}
                      es global en Docker.
                    </p>
                  )}

                  {sinGuardar && (
                    <p className="text-[11px] text-fg-subtle">
                      Hay cambios sin guardar en el editor. El despliegue usa el
                      archivo del disco, que no es lo que hay aquí: guarda o descarta
                      los cambios primero.
                    </p>
                  )}
                  {!sinGuardar && plan.proyecto_en_uso?.mismo_archivo && (
                    <p className="text-[11px] text-fg-subtle">
                      Este proyecto ya está en marcha. Desplegar lo reinicia.
                    </p>
                  )}

                  {!bloqueadoPorColision && (
                    <button
                      type="button"
                      // Deshabilitado y no escondido: se ve que la acción existe y
                      // por qué no está disponible ahora mismo.
                      disabled={sinGuardar}
                      onClick={() =>
                        tieneBuild(plan) ? setPidiendoCoste(true) : setDesplegando(true)
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
                    >
                      <Rocket className="w-3.5 h-3.5" />
                      Desplegar
                    </button>
                  )}

                  <p
                    data-testid="resolved-by"
                    className="text-[10px] text-fg-subtle flex items-center gap-1.5"
                  >
                    <Terminal className="w-3 h-3" />
                    Resuelto por <code className="font-mono">docker compose config</code>,
                    el mismo binario que ejecutaría el proyecto: por eso el plan
                    no puede discrepar de la realidad.
                  </p>

                  {plan.warnings.length > 0 && (
                    <div
                      data-testid="compose-warnings"
                      title="Compose validó el archivo pero avisó de algo. No es un error."
                      className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20"
                    >
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-700 dark:text-amber-400 mb-1">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Avisos de compose ({plan.warnings.length})
                      </div>
                      <ul className="space-y-1">
                        {plan.warnings.map((aviso, index) => (
                          <li
                            key={index}
                            className="text-[10px] font-mono text-amber-700/90 dark:text-amber-300/90 break-all"
                          >
                            {aviso}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div>
                    <h4 className="text-xs font-semibold text-fg mb-1.5">
                      Proyecto <span className="font-mono">{plan.project_name}</span>
                    </h4>
                    <p className="text-[10px] text-fg-subtle font-mono truncate">
                      {plan.source_path}
                    </p>
                  </div>

                  <div>
                    <h4 className="text-xs font-semibold text-fg mb-1.5">
                      Servicios ({plan.services.length})
                    </h4>
                    {plan.services.length === 0 ? (
                      <p className="text-[11px] text-fg-subtle">
                        El archivo no declara servicios.
                      </p>
                    ) : (
                      <ul className="space-y-1.5">
                        {plan.services.map((service) => (
                          <TarjetaServicio key={service.name} service={service} />
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <h4 className="text-xs font-semibold text-fg mb-1.5">
                        Redes ({plan.networks.length})
                      </h4>
                      {plan.networks.length === 0 ? (
                        <p className="text-[11px] text-fg-subtle">Sin redes propias.</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {plan.networks.map((network) => (
                            <Recurso
                              key={network.name}
                              testId={`network-logical-${network.logical_name || network.name}`}
                              logico={network.logical_name}
                              nombre={network.name}
                              subtitulo={network.driver}
                              existe={network.exists}
                              externo={network.external}
                            />
                          ))}
                        </ul>
                      )}
                    </div>

                    <div>
                      <h4 className="text-xs font-semibold text-fg mb-1">
                        Volúmenes ({plan.volumes.length})
                      </h4>
                      {plan.volumes.length === 0 ? (
                        <p className="text-[11px] text-fg-subtle">Sin volúmenes.</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {plan.volumes.map((volume) => (
                            <Recurso
                              key={volume.name}
                              testId={`volume-logical-${volume.logical_name || volume.name}`}
                              logico={volume.logical_name}
                              nombre={volume.name}
                              subtitulo={volume.driver}
                              existe={volume.exists}
                              externo={volume.external}
                            />
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                !error && (
                  <p className="text-[11px] text-fg-subtle">
                    Elige un archivo compose y pulsa <strong>Validar</strong> para
                    ver qué crearía, sin ejecutar nada.
                  </p>
                )
              )}
            </div>
          </div>
        </div>
      </div>

      {/* El explorador va fuera del `div` del modal: es otro dialogo, y anidarlo
          haria que al cerrarlo se cerrara tambien la previsualizacion. */}
      {desplegando && plan && (
        <ComposeActionPanel
          project={plan.project_name}
          path={plan.source_path}
          accionInicial="up"
          // Sin `--remove-orphans`: este nombre puede chocar con otro proyecto y
          // el flag se llevaría contenedores ajenos (SPEC-15 §3.3).
          removeOrphans={false}
          onClose={() => setDesplegando(false)}
          onRefrescar={onRefrescar}
        />
      )}

      {plan && (
        <ComposeDeployDialog
          open={pidiendoCoste}
          plan={plan}
          onCancel={() => setPidiendoCoste(false)}
          onConfirm={() => {
            setPidiendoCoste(false)
            setDesplegando(true)
          }}
        />
      )}

      <ComposeFilePicker
        open={eligiendo}
        onClose={() => setEligiendo(false)}
        onSelect={(elegida) => {
          setPath(elegida)
          // El plan anterior es de otro archivo: dejarlo puesto seria mostrar un
          // resumen que ya no corresponde a la ruta del campo.
          setPlan(null)
          setError(null)
        }}
      />
    </div>
  )
}

/**
 * Si algún servicio del plan va a construirse, y por tanto hay que avisar.
 *
 * Comprobación por valor y no `!== null`: un `build` ausente llega como
 * `undefined` en los datos viejos, y `undefined !== null` es `true`, así que
 * cualquier plan sin coste acabaría preguntando por un build inexistente.
 */
function tieneBuild(plan: ComposePlan): boolean {
  return plan.services.some((servicio) => Boolean(servicio.build))
}
