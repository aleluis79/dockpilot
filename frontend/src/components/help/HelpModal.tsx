// SPDX-License-Identifier: AGPL-3.0-or-later
import React, { useEffect, useRef, useState } from 'react'
import {
  X,
  HelpCircle,
  ShieldAlert,
  Container,
  Layers,
  HardDrive,
  Network as NetworkIcon,
  Server,
  Trash2,
  Radio,
  Boxes,
  FileSearch,
} from 'lucide-react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'

interface HelpModalProps {
  open: boolean
  onClose: () => void
}

type SeccionId = 'general' | 'pestanas' | 'peligro' | 'vivo' | 'problemas'

const SECCIONES: { id: SeccionId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'pestanas', label: 'Pestañas' },
  { id: 'peligro', label: 'Acciones irreversibles' },
  { id: 'vivo', label: 'Datos en vivo' },
  { id: 'problemas', label: 'Si algo no funciona' },
]

/** Una fila de la lista de pestañas: icono, nombre y qué hace. */
function TablaPestanas({
  icono: Icono,
  titulo,
  children,
}: {
  icono: typeof Container
  titulo: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-3">
      <Icono className="w-5 h-5 mt-0.5 shrink-0 text-fg-subtle" />
      <div className="min-w-0">
        <h4 className="text-base font-semibold text-fg">{titulo}</h4>
        <p className="text-[13px] text-fg-muted leading-relaxed mt-1 max-w-[68ch]">{children}</p>
      </div>
    </div>
  )
}

export const HelpModal: React.FC<HelpModalProps> = ({ open, onClose }) => {
  const [seccion, setSeccion] = useState<SeccionId>('general')
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      setSeccion('general')
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Al abrir, el foco entra en el diálogo: si no, Escape y la lectura por
  // pantalla empiezan en la página de fondo.
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  if (!open) return null

  return (
    <div className={`${MODAL_OVERLAY} p-4`} onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-surface border border-default rounded-2xl w-full max-w-5xl max-h-[92vh] flex flex-col shadow-2xl outline-none"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Ayuda y manual de uso"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-default shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <HelpCircle className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0" />
            <h2 className="text-base font-semibold text-fg">Ayuda</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-fg-muted hover:text-fg hover:bg-fg/10 rounded-lg transition-colors cursor-pointer"
            aria-label="Cerrar ayuda"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex gap-8 px-6 py-6 overflow-y-auto min-h-0">
          <nav
            className="shrink-0 w-48 space-y-1"
            aria-label="Secciones de la ayuda"
          >
            {SECCIONES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSeccion(s.id)}
                aria-current={seccion === s.id ? 'page' : undefined}
                className={`w-full text-left px-3 py-2 text-[13px] rounded-lg transition-colors cursor-pointer ${
                  seccion === s.id
                    ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300 font-medium'
                    : 'text-fg-muted hover:text-fg hover:bg-fg/5'
                }`}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="flex-1 min-w-0 space-y-6">
            {seccion === 'general' && (
              <>
                <div>
                  <h3 className="text-base font-semibold text-fg">General</h3>
                  <p className="text-[13px] text-fg-muted leading-relaxed mt-2 max-w-[68ch]">
                    DockPilot opera el daemon de Docker de este host a través del
                    socket local. Todo lo que ves aquí es lectura y acción
                    directa sobre los contenedores, imágenes, volúmenes y redes
                    que tienes en marcha.
                  </p>
                </div>

                <div
                  className="flex gap-3 p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl"
                  role="note"
                >
                  <ShieldAlert className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-px" />
                  <p className="text-[13px] text-rose-700 dark:text-rose-400 leading-relaxed max-w-[68ch]">
                    <strong className="font-semibold">Esta aplicación no tiene autenticación.</strong>{' '}
                    Quien pueda alcanzar el puerto controla el host: puede borrar
                    volúmenes y redes. Mantenla en <code className="font-mono">127.0.0.1</code> y
                    no la expongas a la red.
                  </p>
                </div>

                <div>
                  <h4 className="text-base font-semibold text-fg">Franja de resumen</h4>
                  <p className="text-[13px] text-fg-muted leading-relaxed mt-1 max-w-[68ch]">
                    La barra bajo el encabezado muestra el{' '}
                    <strong className="text-fg">Resumen del host</strong>: versión de
                    Docker, sistema, núcleos, RAM, driver de almacenamiento y el
                    espacio recuperable. Al desplegarla tienes el desglose por tipo
                    de recurso y los mayores consumidores de disco.
                  </p>
                </div>
              </>
            )}

            {seccion === 'pestanas' && (
              <>
                <div>
                  <h3 className="text-base font-semibold text-fg">Pestañas</h3>
                  <p className="text-[13px] text-fg-muted mt-2">
                    Los recursos se organizan en cinco pestañas, cada una con sus
                    filtros y su buscador.
                  </p>
                </div>

                <div className="grid sm:grid-cols-2 gap-x-8 gap-y-5">
                  <TablaPestanas icono={Container} titulo="Contenedores">
                    Listado completo, con estado y puertos. Desde aquí se arranca,
                    detiene, reinicia, pausa y borra, y se abren los logs, las
                    estadísticas, la terminal y el detalle. El botón{' '}
                    <strong className="text-fg">Nuevo Contenedor</strong> crea uno
                    desde cero.
                  </TablaPestanas>

                  <TablaPestanas icono={Layers} titulo="Imágenes">
                    Solo las imágenes que ya están en el host. Se pueden
                    inspeccionar, ejecutar, descargar desde Docker Hub y borrar.
                    Las que usa algún contenedor no se borran sin forzar.
                  </TablaPestanas>

                  <TablaPestanas icono={HardDrive} titulo="Volúmenes">
                    Con su tamaño real y el número de contenedores que los usan.
                    <strong className="text-fg"> Ninguno</strong> significa que se
                    puede borrar sin forzar; en cuanto hay contenedores, el
                    borrado da error hasta que se marque forzar.
                  </TablaPestanas>

                  <TablaPestanas icono={NetworkIcon} titulo="Redes">
                    Con sus subredes, puerta de enlace y contenedores conectados.
                    Se pueden crear indicando un CIDR o dejar que Docker asigne el
                    siguiente libre. Las predefinidas se muestran atenuadas y no se
                    pueden borrar.
                  </TablaPestanas>

                  <TablaPestanas icono={Boxes} titulo="Proyectos">
                    Los proyectos de <strong className="text-fg">Docker Compose</strong>{' '}
                    que hay en el host, agrupando contenedores, redes y volúmenes
                    por proyecto. Un proyecto marcado{' '}
                    <strong className="text-fg">Huerfano</strong> ya no tiene
                    contenedores pero conserva recursos que ocupan espacio. Desde
                    aquí se levantan, detienen y bajan, se siguen sus logs en vivo
                    y se previsualiza un archivo compose antes de tocar nada. En las
                    otras pestañas, la columna{' '}
                    <strong className="text-fg">Proyecto</strong> dice a cuál
                    pertenece cada recurso.
                  </TablaPestanas>

                  <TablaPestanas icono={FileSearch} titulo="Previsualizar compose">
                    Con <strong className="text-fg">Plan</strong> se indica la ruta
                    de un archivo compose y se ve qué crearía: servicios, puertos,
                    redes y volúmenes, distinguiendo lo que ya existe de lo que se
                    crearía. <strong className="text-fg">No ejecuta nada</strong> ni
                    modifica el archivo, y el editor permite probar un cambio a ver
                    qué daría. Las operaciones reales van en la fila del proyecto.
                    <br />
                    <br />
                    <strong className="text-fg">Desplegar</strong> arranca el archivo
                    desde aquí, sin salir del panel: es lo que permite poner en marcha
                    un compose que no está en la tabla, porque un archivo que nunca ha
                    corrido no deja etiquetas y no aparece en{' '}
                    <strong className="text-fg">Proyectos</strong>. Si algún servicio
                    declara <code className="font-mono">build</code> y no tiene imagen,
                    Docker la construye antes de arrancar, así que antes de hacerlo se
                    dice cuántos servicios son y cuánto pesa el contexto —los pesos no
                    aplican <code className="font-mono">.dockerignore</code> y suelen
                    ser algo mayores—. Se llama Desplegar y no Iniciar porque con
                    <code className="text-fg"> build</code> puede no ser inmediato. Si
                    el despliegue se queda a medias, el proyecto aparece igualmente en
                    la tabla, y{' '}
                    <strong className="text-fg">Bajar</strong> es lo que lo limpia.
                    <br />
                    <br />
                    <strong className="text-fg">Seleccionar archivo</strong> abre un
                    explorador para no tener que copiar la ruta a mano, que es como se
                    acababa previsualizando el proyecto equivocado. Solo recorre tu
                    directorio personal: los proyectos que no están en marcha no
                    dejan etiquetas y no aparecen en la tabla, así que son justo los
                    que hay que ir a buscar. El campo sigue siendo editable para los
                    archivos que estén fuera.
                  </TablaPestanas>
                </div>
              </>
            )}

            {seccion === 'peligro' && (
              <>
                <div>
                  <h3 className="text-base font-semibold text-fg">
                    Acciones irreversibles
                  </h3>
                  <p className="text-[13px] text-fg-muted mt-2">
                    Estas acciones <strong className="text-fg">no se puede deshacer</strong>.
                    Todas piden confirmación, pero conviene leer lo que dice el
                    diálogo antes de aceptar.
                  </p>
                </div>

                <ul className="grid sm:grid-cols-2 gap-x-8 gap-y-4 text-[13px] text-fg-muted">
                  <li className="flex gap-2.5">
                    <Trash2 className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-px" />
                    <span>
                      <strong className="text-fg">Borrar</strong> un contenedor, una
                      imagen, un volumen o una red. En el caso del contenedor,
                      marcar <em>forzar</em> mata el proceso sin apagado limpio.
                    </span>
                  </li>
                  <li className="flex gap-2.5">
                    <Trash2 className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-px" />
                    <span>
                      <strong className="text-fg">Limpiar sin uso</strong> en
                      volúmenes o redes elimina de golpe todo lo que no está en
                      uso. El diálogo indica cuántos son y cuánto espacio se
                      recupera, pero una vez confirmado no hay vuelta atrás.
                    </span>
                  </li>
                  <li className="flex gap-2.5">
                    <Trash2 className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-px" />
                    <span>
                      <strong className="text-fg">Borrar una imagen</strong> no la
                      descarga de nuevo: luego habrá que volver a bajarla de Docker
                      Hub.
                    </span>
                  </li>
                  <li className="flex gap-2.5">
                    <Trash2 className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-px" />
                    <span>
                      <strong className="text-fg">Bajar un proyecto compose con
                      sus volúmenes</strong>. Es la acción más destructiva del
                      panel: borra los datos de todos sus volúmenes a la vez. No
                      se activa por defecto, exige dos confirmaciones y el
                      diálogo enseña los nombres reales de lo que desaparece. Si
                      el proyecto tiene contenedores en marcha, el panel lo
                      rechaza y hay que pararlo antes.
                    </span>
                  </li>
                </ul>

                <div
                  className="p-4 bg-elevated border border-default rounded-xl text-[13px] text-fg-muted leading-relaxed max-w-[76ch]"
                  role="note"
                >
                  <strong className="text-fg">Lo que está protegido</strong>, y no
                  se toca ni siquiera al forzar: los volúmenes que algún contenedor
                  está usando, y las redes predefinidas de Docker (
                  <code className="font-mono">none</code>,{' '}
                  <code className="font-mono">host</code> y{' '}
                  <code className="font-mono">bridge</code>). Las redes
                  predefinidas <strong className="text-fg">no se tocan</strong> en
                  la limpieza. En compose, bajar un proyecto{' '}
                  <strong className="text-fg">nunca</strong> borra volúmenes
                  salvo que se marque expresamente la opción: por defecto se lleva
                  contenedores y red y deja los datos intactos.
                </div>
              </>
            )}

            {seccion === 'vivo' && (
              <>
                <div>
                  <h3 className="text-base font-semibold text-fg">
                    Datos en vivo
                  </h3>
                  <p className="text-[13px] text-fg-muted mt-2">
                    Logs, estadísticas, terminal y las acciones de compose no son
                    peticiones normales: se mantienen abiertos por{' '}
                    <strong className="text-fg">WebSocket</strong>.
                  </p>
                </div>
                <ul className="grid sm:grid-cols-2 gap-x-8 gap-y-4 text-[13px] text-fg-muted">
                  <li className="flex gap-2.5">
                    <Radio className="w-5 h-5 text-fg-subtle shrink-0 mt-px" />
                    <span>
                      Si la conexión se cae, el panel reintenta solo. Mientras tanto
                      los datos en pantalla son los últimos recibidos, no el estado
                      actual: conviene volver a abrir la vista.
                    </span>
                  </li>
                  <li className="flex gap-2.5">
                    <Radio className="w-5 h-5 text-fg-subtle shrink-0 mt-px" />
                    <span>
                      Los logs muestran las últimas líneas al abrir y luego siguen
                      en streaming. Con <em>seguir</em> activado no se puede
                      cerrar la vista: el navegador mantiene la conexión abierta.
                    </span>
                  </li>
                  <li className="flex gap-2.5">
                    <Radio className="w-5 h-5 text-fg-subtle shrink-0 mt-px" />
                    <span>
                      La terminal exige que el contenedor siga{' '}
                      <strong className="text-fg">en ejecución</strong>. Con el
                      contenedor detenido no hay shell a la que conectarse.
                    </span>
                  </li>
                  <li className="flex gap-2.5">
                    <Radio className="w-5 h-5 text-fg-subtle shrink-0 mt-px" />
                    <span>
                      Las acciones de compose enseñan el comando exacto antes de
                      ejecutarlo y su salida en vivo, y se pueden{' '}
                      <strong className="text-fg">cancelar</strong>: el proceso se
                      detiene en el servidor y el proyecto se queda como estaba. Si
                      compose falla, el panel lo dice como fallo de compose y no
                      como error suyo: el comando llegó a ejecutarse.
                    </span>
                  </li>
                </ul>
                <p className="text-[13px] text-fg-subtle leading-relaxed">
                  Los datos en vivo viajan por el mismo origen que la página, así
                  que no hay que configurar nada: si la web carga, los WebSockets
                  también.
                </p>
              </>
            )}

            {seccion === 'problemas' && (
              <>
                <div>
                  <h3 className="text-base font-semibold text-fg">
                    Si algo no funciona
                  </h3>
                </div>

                <div className="space-y-4 text-[13px] text-fg-muted">
                  <div>
                    <h4 className="text-fg font-semibold text-[15px]">Dice que no hay conexión</h4>
                    <p className="leading-relaxed mt-0.5">
                      El backend no logra hablar con el socket{' '}
                      <code className="font-mono">/var/run/docker.sock</code>. Comprueba
                      que el daemon esté en marcha y que el usuario que ejecuta el
                      backend tenga permiso sobre ese socket.
                    </p>
                  </div>

                  <div>
                    <h4 className="text-fg font-semibold text-[15px]">Falla al arrancar el frontend</h4>
                    <p className="leading-relaxed mt-0.5">
                      Si el puerto ya está ocupado, <code className="font-mono">make up</code>{' '}
                      lo dice y se detiene. No se mueve solo de puerto: para cambiarlo,
                      edita <code className="font-mono">PORT_BACKEND</code> y{' '}
                      <code className="font-mono">PORT_FRONTEND</code> en el{' '}
                      <code className="font-mono">Makefile</code>.
                    </p>
                  </div>

                  <div>
                    <h4 className="text-fg font-semibold text-[15px]">El navegador dice que hay CORS</h4>
                    <p className="leading-relaxed mt-0.5">
                      Pasa al abrir <code className="font-mono">/docs</code> desde el
                      navegador. La dirección debe coincidir con el puerto del
                      frontend; si no, ajusta{' '}
                      <code className="font-mono">FRONTEND_PORT</code> al arrancar el
                      backend.
                    </p>
                  </div>

                  <div>
                    <h4 className="text-fg font-semibold text-[15px]">
                      No deja desplegar porque el nombre está ocupado
                    </h4>
                    <p className="leading-relaxed mt-0.5">
                      Dos archivos compose con el mismo nombre se pelean por los mismos
                      recursos, y <code className="font-mono">container_name</code> es
                      global en Docker. Si el nombre ya lo usa un{' '}
                      <strong className="text-fg">proyecto distinto</strong>, el panel
                      lo bloquea y dice cuál. Si es el mismo archivo, no hay conflicto:
                      desplegar solo lo reinicia.
                    </p>
                  </div>

                  <div>
                    <h4 className="text-fg font-semibold text-[15px]">
                      Los proyectos compose no se pueden operar
                    </h4>
                    <p className="leading-relaxed mt-0.5">
                      Las acciones de la pestaña{' '}
                      <strong className="text-fg">Proyectos</strong> y la
                      previsualización necesitan el CLI de Docker Compose (
                      <code className="font-mono">docker compose</code>). Si no está
                      instalado, el panel lo avisa. El{' '}
                      <strong className="text-fg">inventario</strong> de proyectos
                      y la columna <em>Proyecto</em> del resto de pestañas siguen
                      funcionando: se leen las etiquetas de los recursos, no el CLI.
                    </p>
                  </div>

                  <div>
                    <h4 className="text-fg font-semibold text-[15px]">
                      El explorador no deja subir ni salir del directorio inicial
                    </h4>
                    <p className="leading-relaxed mt-0.5">
                      <strong className="text-fg">Seleccionar archivo</strong> solo
                      recorre tu directorio personal, y la flecha de subir se apaga
                      cuando ya estás en la raíz: es el límite, no un fallo. Si el
                      archivo compose está en otro sitio, escribe la ruta en el campo,
                      que sigue siendo editable. Los enlaces simbólicos que apuntan
                      fuera del directorio personal no se listan, y el panel avisa de
                      cuántos ha omitido.
                    </p>
                  </div>

                  <div>
                    <h4 className="text-fg font-semibold text-[15px]">Faltan logs o estadísticas</h4>
                    <p className="leading-relaxed mt-0.5">
                      El driver de registro del contenedor no es compatible con
                      <code className="font-mono"> json-file</code>, que es el que
                      Docker usa para poder releerlos. Es una limitación del host, no
                      del panel.
                    </p>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-default shrink-0">
          <p className="text-[13px] text-fg-subtle">
            <Server className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />
            Gestor local de Docker, v0.1.0
          </p>
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-medium transition-all shadow-lg shadow-blue-500/20 cursor-pointer"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
