// SPDX-License-Identifier: AGPL-3.0-or-later
import { Container, Layers, HardDrive, Network, Boxes, type LucideIcon } from 'lucide-react'

export type ClaveVista = 'containers' | 'images' | 'volumes' | 'networks' | 'projects'

export interface Vista {
  key: ClaveVista
  label: string
  icon: LucideIcon
}

/**
 * Las pestañas del panel, en un solo sitio.
 *
 * Antes vivían en el `App.tsx` y la ayuda las copiaba a mano, así que cuando se
 * añadió `Proyectos` el manual siguió diciendo "cuatro pestañas" sin que nada se
 * enterara. Compartir la lista hace que la ayuda sea imposible de dejar
 * desfasada: el test de `HelpModal` la recorre y compara con esta constante.
 */
export const VISTAS: Vista[] = [
  { key: 'containers', label: 'Contenedores', icon: Container },
  { key: 'images', label: 'Imágenes', icon: Layers },
  { key: 'volumes', label: 'Volúmenes', icon: HardDrive },
  { key: 'networks', label: 'Redes', icon: Network },
  { key: 'projects', label: 'Proyectos', icon: Boxes },
]

