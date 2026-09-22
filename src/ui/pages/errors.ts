/**
 * Error page surface.
 *
 * app.ts imports only this module for its HTML error handling, so a failure while
 * rendering an error cannot pull in the whole page tree. These are re-exports rather
 * than new implementations: the components live with the rest of the layout so the
 * error page uses the same tokens as everything else.
 */

export { serverErrorPage, notFoundPage } from '../layout';
