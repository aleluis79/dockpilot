/**
 * Superficie compartida de los overlays (velo) de todos los modales.
 *
 * Antes cada modal declaraba su propia opacidad de velo y acabaron siendo
 * cuatro velos distintos para la misma interacción. Centralizarlo aquí impide
 * que vuelvan a divergir.
 *
 * Solo cubre posicionamiento, velo y animación. El padding, el `max-width` y
 * los extras (`overflow-hidden`, `font-sans`) siguen siendo responsabilidad de
 * cada modal, porque son decisiones de layout propias de cada uno.
 *
 * `animate-fade-in` está definido en `src/index.css`. No se usa `animate-in`
 * porque requiere el plugin `tailwindcss-animate`, que el proyecto no tiene.
 */
export const MODAL_OVERLAY =
  'fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in'
