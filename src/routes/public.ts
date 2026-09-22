/**
 * Public routes (§3, §8, §49, §50, §51).
 *
 * These are the only unauthenticated surfaces that read real data, so they are all
 * rate-limited by IP and all of them are `noindex`. The invoice id is the capability:
 * anyone holding the URL may view the invoice, which is exactly how a payment link
 * works, so the page discloses only what a payer needs and nothing about the merchant's
 * business beyond the invoice in front of them.
 *
 * `/pay/:invoiceId/success` and `/expired` exist as separate paths because merchants
 * configure them as return URLs from their own sites. They render the *true* state of the
 * invoice rather than assuming the path is correct: a customer who bookmarks `/success`
 * for an invoice that later expired must see "expired", and a crafted link cannot show a
 * "paid" page for an unpaid invoice.
 */

import type { Hono } from 'hono';
import type { AppEnv, RouteContext } from '../app';
import { servicesFor } from './container';
import { html, json, redirect, text } from '../core/http';
import { AppError } from '../core/errors';
import { publicInvoiceRule } from '../services/ratelimit';
import { RateLimitSignal } from './api';
import { rateLimited } from '../core/http';
import { payPage } from '../ui/pages/pay';
import { landingPage } from '../ui/pages/landing';
import { docsPage } from '../ui/pages/docs';
import { serverErrorPage } from '../ui/layout';
import type { InvoiceService } from '../services/invoices';

/** What the public invoice view returns, without restating the shape by hand. */
type PublicView = NonNullable<Awaited<ReturnType<InvoiceService['getPublicView']>>>;

/** Shared guard: one IP-scoped budget for everything a stranger can reach. */
async function guard(c: RouteContext, scope: string): Promise<void> {
  const context = c.get('appContext');
  const services = servicesFor(context);
  const limit = await services.rateLimiter.consume(
    `${scope}:${context.clientIp ?? 'unknown'}`,
    publicInvoiceRule(await services.settings.int('rate_limit.public_invoice_per_minute')),
  );
  if (!limit.allowed) {
    throw new RateLimitSignal(rateLimited(limit.retryAfterSeconds, context.requestId, limit.limit));
  }
}

export function registerPublicRoutes(app: Hono<AppEnv>): void {
  // -------------------------------------------------------------------------
  // Landing
  // -------------------------------------------------------------------------
  app.get('/', async (c) => {
    const context = c.get('appContext');
    // Cacheable: this page is identical for every visitor and contains no data. Letting
    // a shared cache hold it briefly means a traffic spike does not become a Worker spike.
    return html(landingPage({ origin: context.origin }), {
      headers: { 'cache-control': 'public, max-age=300' },
    });
  });

  // -------------------------------------------------------------------------
  // Documentation
  // -------------------------------------------------------------------------
  //
  // Static content, cacheable, and reachable without an account: an integrator reads
  // the reference before they have a key. Served on two paths because `/docs` is what
  // the navigation links to and `/docs/api` is the older address that is already in
  // bookmarks and in `robots.txt`.
  //
  // The origin is passed in rather than baked in: every example on the page shows the
  // host the reader is actually on, so documentation copied out of the browser is
  // correct on a preview URL, on `*.pages.dev`, and on the custom domain, with no
  // placeholder for the reader to find and replace.
  const docs = (c: RouteContext): Response =>
    html(docsPage({ origin: c.get('appContext').origin }), {
      headers: { 'cache-control': 'public, max-age=300' },
    });

  app.get('/docs', docs);
  app.get('/docs/api', docs);

  // -------------------------------------------------------------------------
  // Payment page
  // -------------------------------------------------------------------------
  /**
   * Loads an invoice or answers 404.
   *
   * Split out from rendering so the three page routes can each rate-limit exactly once:
   * the previous shape had `/success` consume a token for its own guard and then consume a
   * second one by delegating to a handler that guarded again, which halved the effective
   * budget on those paths for no reason.
   */
  const loadView = async (c: RouteContext): Promise<PublicView | null> => {
    const services = servicesFor(c.get('appContext'));
    return services.invoices.getPublicView(c.req.param('invoiceId') ?? '');
  };

  const renderView = async (c: RouteContext, view: PublicView): Promise<Response> => {
    const context = c.get('appContext');
    const services = servicesFor(context);

    // The receipt for a paid invoice quotes the bank's own message, redacted. Only fetched
    // for a paid invoice: there is no message to show before the money arrives, and the
    // extra query would be wasted on the common case of someone about to pay.
    const bankMessage =
      view.invoice.status === 'PAID'
        ? await services.sms.publicConfirmationMessage(view.invoice.id, {
            amountToman: view.invoice.payable_amount,
            amountRial: view.invoice.payable_amount_rial,
            reference: view.transaction?.bank_reference ?? null,
          })
        : null;

    const page = payPage({
      invoice: view.invoice,
      merchant: view.merchant,
      card: view.card,
      openability: view.openability,
      transaction: view.transaction,
      bankMessage,
    });

    // A paid or expired page is stable, so it can be cached briefly; a payable one must
    // not be, or a customer could be shown a stale countdown or a stale card.
    const final = view.openability.kind !== 'PAYABLE';
    return html(page, {
      noStore: !final,
      headers: final ? { 'cache-control': 'private, max-age=60' } : {},
    });
  };

  const notFoundInvoice = (): Response => {
    return html(
      serverErrorPage({
        title: 'فاکتور پیدا نشد',
        message: 'این فاکتور وجود ندارد یا حذف شده است. لینک پرداخت را دوباره از پذیرنده بگیرید؛ ممکن است ناقص کپی شده باشد.',
        status: 404,
      }),
      { status: 404, noStore: true },
    );
  };

  app.get('/pay/:invoiceId', async (c) => {
    await guard(c, 'pay');
    const view = await loadView(c);
    return view ? renderView(c, view) : notFoundInvoice();
  });

  // Return-URL targets. Both render whatever is actually true, and when the invoice is
  // not in the state the path names, the customer is sent to the canonical page so their
  // address bar always matches reality.
  app.get('/pay/:invoiceId/success', async (c) => {
    await guard(c, 'pay');
    const view = await loadView(c);
    if (!view) return notFoundInvoice();
    if (view.invoice.status !== 'PAID') return redirect(`/pay/${view.invoice.id}`, 302);
    return renderView(c, view);
  });

  app.get('/pay/:invoiceId/expired', async (c) => {
    await guard(c, 'pay');
    const view = await loadView(c);
    if (!view) return notFoundInvoice();
    if (view.invoice.status !== 'EXPIRED') return redirect(`/pay/${view.invoice.id}`, 302);
    return renderView(c, view);
  });

  // -------------------------------------------------------------------------
  // Invoice status — polled by the payment page, and useful to a merchant server
  // -------------------------------------------------------------------------
  app.get('/status/:invoiceId', async (c) => {
    await guard(c, 'status');

    const context = c.get('appContext');
    const services = servicesFor(context);
    const invoiceId = c.req.param('invoiceId') ?? '';

    const view = await services.invoices.getPublicView(invoiceId);
    if (!view) throw new AppError('INVOICE_NOT_FOUND', { details: { invoiceId } });

    // Deliberately minimal. This endpoint has no credential beyond the invoice id, so it
    // confirms the state of an invoice the caller already knows the id of, and discloses
    // no amount, no merchant identity and no card. The browser polls it; anything more
    // would be a public API for enumerating invoices.
    return json(
      {
        invoiceId: view.invoice.id,
        status: view.invoice.status,
        expiresAt: view.invoice.expires_at,
        paidAt: view.invoice.paid_at,
        updatedAt: view.invoice.updated_at,
      },
      { noStore: true, headers: { 'x-request-id': context.requestId } },
    );
  });

  // -------------------------------------------------------------------------
  // robots.txt — keep crawlers out of invoice pages entirely
  // -------------------------------------------------------------------------
  app.get('/robots.txt', () => {
    return text(
      [
        'User-agent: *',
        'Disallow: /pay/',
        'Disallow: /status/',
        'Disallow: /api/',
        'Disallow: /dashboard/',
        'Disallow: /admin/',
        'Allow: /',
        'Allow: /docs/api',
        '',
      ].join('\n'),
      { headers: { 'cache-control': 'public, max-age=86400' } },
    );
  });
}
