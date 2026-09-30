// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reglas de nombre de contenedor (SPEC-19).
 *
 * Duplicadas a propósito en cliente y servidor, y **no** por descuido: el
 * backend tiene que validar porque es la frontera con el daemon, y el cliente
 * porque una validación que exige un viaje por red se siente lenta y deja al
 * usuario descubriendo las reglas a base de `400`.
 *
 * El riesgo de la duplicación es que se separen. Se evita con una fuente única
 * de verdad por constante, y porque las tres reglas se comprobaron contra el
 * daemon 29.8.1 antes de escribirlas. Si cambia algo, cambia en los dos sitios
 * y el test de contrato del backend es quien lo detecta.
 */

/** `[a-zA-Z0-9][a-zA-Z0-9_.-]+`: el `+` es lo que exige el mínimo de dos. */
export const PATRON_NOMBRE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;

/**
 * 63 es el tope que usa el daemon para redes y el de una etiqueta DNS.
 * Los contenedores no tienen tope en el daemon —comprobado: acepta 300
 * caracteres— pero un nombre así no puede ser un nombre de host, así que
 * rompería la resolución en cuanto el contenedor toque una red personalizada.
 */
export const MAX_NOMBRE = 63;

/** Cómo se llama cada carácter prohibido, para poder nombrarlo en el mensaje. */
const PROHIBIDOS: Record<string, string> = {
  ' ': 'espacios',
  '/': 'barras',
  ':': 'dos puntos',
  '\\': 'barras invertidas',
  '@': 'arrobas',
  '#': 'almohadillas',
  $: 'signos de dólar',
  '%': 'signos de porcentaje',
};

export interface ResultadoNombre {
  valido: boolean;
  error?: string;
}

/**
 * Valida un nombre de contenedor sin preguntar a nadie.
 *
 * `nombreActual` y `otrosNombres` son opcionales: con ellos se cubren dos reglas
 * más que no se pueden decidir sin contexto —no cambiar, y no colisionar— y que
 * tampoco justifican un viaje al daemon, porque el panel ya tiene el inventario
 * cargado.
 */
export function validarNombreContenedor(
  bruto: string,
  opciones: { nombreActual?: string; otrosNombres?: Iterable<string> } = {}
): ResultadoNombre {
  const nombre = (bruto ?? '').trim()
  const { nombreActual, otrosNombres } = opciones

  if (!nombre) return { valido: false, error: 'El nombre no puede estar vacío.' }

  if (nombre.length < 2) {
    return {
      valido: false,
      error: 'El nombre necesita al menos dos caracteres; uno solo no lo acepta Docker.',
    }
  }

  if (nombre.length > MAX_NOMBRE) {
    return {
      valido: false,
      error:
        `El nombre no puede superar ${MAX_NOMBRE} caracteres. Es el tope de un nombre ` +
        'de host, y uno más largo no podría resolver en una red personalizada.',
    }
  }

  const prohibido = [...nombre].find((c) => !/[a-zA-Z0-9_.-]/.test(c))
  if (prohibido) {
    const como = PROHIBIDOS[prohibido] ?? `'${prohibido}'`
    return {
      valido: false,
      error: `El nombre no puede contener ${como}. Solo se permiten letras, dígitos, punto, guion y guion bajo.`,
    }
  }

  if (!PATRON_NOMBRE.test(nombre)) {
    return {
      valido: false,
      error:
        'El nombre solo puede llevar letras, dígitos, punto, guion y guion bajo, ' +
        'y debe empezar por letra o dígito.',
    }
  }

  if (nombreActual && nombre === nombreActual) {
    return { valido: false, error: 'El nombre no ha cambiado.' }
  }

  if (otrosNombres) {
    for (const otro of otrosNombres) {
      if (otro === nombre) {
        return { valido: false, error: `Ya existe un contenedor llamado '${nombre}'.` }
      }
    }
  }

  return { valido: true }
}

/** Redes en las que Docker no hace resolución de nombres. */
export const REDES_SIN_NOMBRES = new Set(['bridge', 'default', 'host', 'none'])

/**
 * La primera red **propia** del contenedor, si tiene alguna.
 *
 * En la red `bridge` por defecto no hay resolución entre contenedores, así que
 * renombrar no rompe nada y avisar sería ruido. En una red propia el nombre del
 * contenedor **es** su nombre DNS, y renombrarlo rompe a quien lo resolvía.
 *
 * Se mira el conjunto de redes conectadas y NO `HostConfig.NetworkMode`: ése es
 * sólo la red principal y dice `bridge` para un contenedor que además está
 * conectado a una red propia, que es justo el caso que hay que detectar.
 * Comprobado contra el daemon.
 */
export function redPropia(networks: readonly string[] | undefined | null): string | null {
  if (!networks) return null
  return networks.find((n) => !REDES_SIN_NOMBRES.has(n)) ?? null
}