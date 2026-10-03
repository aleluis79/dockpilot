// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ContainerSummary } from '../types/docker'

/**
 * Los contenedores del propio panel no se pueden parar ni borrar desde el panel.
 *
 * El panel se ve a sí mismo en su propio listado y su API puede pararlo o
 * borrarlo, así que el botón que lo apaga está a un clic de apagarlo a él. Y no
 * hay red de seguridad detrás: se comprobó que **ninguna** política de reinicio
 * de Docker lo recupera, porque un `stop` que viene de la API lo cuenta como
 * parada deliberada y suspende la política. Sin este filtro, un clic equivocado
 * deja el panel apagado y solo se levanta con `docker compose start backend`.
 *
 * ## Por qué el proyecto compose y no el nombre
 *
 * El nombre del contenedor cambia (`dockpilot-backend-1` hoy, otra cosa mañana
 * con otro número de réplicas o un nombre de proyecto distinto), mientras que la
 * etiqueta `com.docker.compose.project` la pone compose y no depende de nada de
 * esto. Un predicado por patrón de nombre se rompe solo, y se rompe en silencio:
 * el botón vuelve a aparecer y nadie sabe por qué.
 *
 * ## Qué NO se bloquea, y es lo importante
 *
 * **Iniciar, reanudar y reiniciar siguen.** El panel se protege de poder matarse,
 * no de poder reencenderse: si el backend ya está caído, el botón de iniciar es
 * lo único que lo levanta, y quitarlo dejaría al usuario sin salida desde la
 * interfaz. Por eso el filtro es sobre acciones destructivas y no sobre el
 * contenedor entero.
 *
 * Se bloquea también **pausar**, que parece inocuo y no lo es: con el backend
 * pausado el socket sigue abierto pero no responde, así que el panel queda
 * igual de inalcanzable que si estuviera parado, y sin botón para volver.
 *
 * ## Configuración
 *
 * `VITE_PROYECTOS_PROTEGIDOS` con lista separada por comas, por si el proyecto no
 * se llama `dockpilot`. Al ser una variable de build, cambiarla exige reconstruir
 * la imagen del frontend; el valor por defecto cubre el `docker compose up` del
 * repositorio, que es el caso normal.
 */

/** El nombre del proyecto compose por defecto es el del directorio. */
const PROYECTO_POR_DEFECTO = 'dockpilot'

function proyectosProtegidos(): string[] {
  const crudo = import.meta.env.VITE_PROYECTOS_PROTEGIDOS
  const lista = (crudo ?? PROYECTO_POR_DEFECTO)
    .split(',')
    .map((p: string) => p.trim())
    .filter(Boolean)
  return lista.length > 0 ? lista : [PROYECTO_POR_DEFECTO]
}

/**
 * Si un contenedor es una pieza del panel.
 *
 * Sin `compose_project` no se protege nada, y es lo correcto: en desarrollo el
 * backend corre en el host, no en un contenedor de este proyecto, así que no
 * hay nada que proteger y los botones se comportan como siempre.
 */
export function esContenedorDelPanel(c: Pick<ContainerSummary, 'compose_project'>): boolean {
  return c.compose_project != null && proyectosProtegidos().includes(c.compose_project)
}

/** Si un nombre de proyecto compose es el del propio panel. */
export function esProyectoDelPanel(nombre: string): boolean {
  return proyectosProtegidos().includes(nombre)
}

/**
 * Si una red es la del panel.
 *
 * Una red no lleva etiqueta de proyecto compose: la red por defecto de un
 * proyecto se llama `<proyecto>_default`. Para el compose de este repositorio
 * eso da `dockpilot_default`, y borrarla deja al panel sin red, que es justo el
 * mismo punto ciego que borrar el contenedor.
 *
 * El sufijo `_default` es el de la red que compose crea cuando el archivo no
 * declara redes, que es el caso de este. Un proyecto propio con redes
 * declaradas en el YAML tendría otros nombres, y se protegerían a mano
 * declarándolos en `VITE_RECURSOS_PROTEGIDOS`.
 */
export function esRedDelPanel(nombre: string): boolean {
  if (redesExtra().includes(nombre)) return true
  return proyectosProtegidos().some((p) => nombre === `${p}_default`)
}

/**
 * Si una imagen es la del panel.
 *
 * Una imagen no tiene proyecto compose: su identidad es su nombre, y el del
 * panel empieza por `dockpilot-`. Aquí el patrón de nombre SÍ es el
 * identificador —una imagen se llama como quiere— y no como el del contenedor,
 * que es un nombre generado.
 */
export function esImagenDelPanel(nombre: string): boolean {
  const [repo] = nombre.split(':')
  return proyectosProtegidos().some((p) => repo === p || repo.startsWith(`${p}-`))
}

/** Nombres de red o imagen que se protegen a mano, por si el patrón no basta. */
function redesExtra(): string[] {
  const crudo = import.meta.env.VITE_RECURSOS_PROTEGIDOS
  return (crudo ?? '')
    .split(',')
    .map((n: string) => n.trim())
    .filter(Boolean)
}

/** El motivo, en una frase, para el `title` del icono que sustituye a los botones. */
export const MOTIVO_PROTEGIDO =
  'Es una pieza del propio panel: si se para o se borra, el panel queda apagado y Docker no lo vuelve a levantar. Se puede con «docker compose start backend».'