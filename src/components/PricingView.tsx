import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  CloudUpload,
  CreditCard,
  HardDrive,
  Infinity,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { motion } from 'framer-motion';
import {
  BillingCheckoutResponse,
  CloudPlanLimit,
  CloudPlansResponse,
  captureBillingCheckout,
  createBillingCheckout,
  getCloudPlans,
} from '../services/cloudShareService';
import { formatBytes } from '../utils/fileUtils';

interface PricingViewProps {
  onOpenCloud: () => void;
}

const GB = 1024 * 1024 * 1024;
const TB = 1024 * GB;
const ENTITLEMENT_STORAGE_KEY = 'ponswarpCloudEntitlementToken';
const PENDING_SUBSCRIPTION_KEY = 'ponswarpPendingSubscriptionId';

const FALLBACK_CLOUD_PLANS: CloudPlansResponse = {
  directP2p: {
    label: 'Direct P2P',
    unlimited: true,
    priceKrw: 0,
  },
  free: {
    sku: 'free_cloud_10gb_24h',
    label: 'Free Cloud Drop',
    priceKrw: 0,
    maxTotalBytes: 10 * GB,
    maxFileBytes: 10 * GB,
    retentionSeconds: 24 * 60 * 60,
    available: true,
  },
  passes: [
    {
      sku: 'drop_100gb_3d',
      label: '100GB Drop Pass',
      priceKrw: 1900,
      maxTotalBytes: 100 * GB,
      maxFileBytes: 100 * GB,
      retentionSeconds: 3 * 24 * 60 * 60,
      downloadLimit: 10,
      available: false,
    },
    {
      sku: 'drop_500gb_7d',
      label: '500GB Drop Pass',
      priceKrw: 4900,
      maxTotalBytes: 500 * GB,
      maxFileBytes: 500 * GB,
      retentionSeconds: 7 * 24 * 60 * 60,
      downloadLimit: 20,
      available: false,
    },
    {
      sku: 'drop_1tb_7d',
      label: '1TB Drop Pass',
      priceKrw: 9900,
      maxTotalBytes: TB,
      maxFileBytes: TB,
      retentionSeconds: 7 * 24 * 60 * 60,
      downloadLimit: 30,
      available: false,
    },
  ],
  pro: {
    sku: 'pro_monthly_krw_9900',
    label: 'PonsWarp Pro',
    priceKrw: 9900,
    maxTotalBytes: TB,
    maxFileBytes: TB,
    retentionSeconds: 7 * 24 * 60 * 60,
    downloadLimit: 30,
    available: false,
    monthlyQuotaBytes: 2 * TB,
    concurrentStorageBytes: TB,
  },
  checkoutEnabled: false,
};

const formatKrw = (value: number) =>
  `${new Intl.NumberFormat('ko-KR').format(value)}원`;

const formatRetention = (seconds: number) => {
  const days = Math.round(seconds / 86400);
  if (days >= 1) return `${days} days`;
  return `${Math.round(seconds / 3600)} hours`;
};

const storeEntitlement = (token: string) => {
  window.sessionStorage.setItem(ENTITLEMENT_STORAGE_KEY, token);
};

const PricingView: React.FC<PricingViewProps> = ({ onOpenCloud }) => {
  const [plans, setPlans] = useState<CloudPlansResponse>(FALLBACK_CLOUD_PLANS);
  const [checkoutSku, setCheckoutSku] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCloudPlans()
      .then(nextPlans => {
        if (!cancelled) setPlans(nextPlans);
      })
      .catch(() => {
        if (!cancelled) setPlans(FALLBACK_CLOUD_PLANS);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') !== 'success') return;

    const subscriptionId =
      params.get('subscription_id') ||
      window.sessionStorage.getItem(PENDING_SUBSCRIPTION_KEY);
    const orderId = params.get('token');

    if (subscriptionId) {
      storeEntitlement(subscriptionId);
      window.sessionStorage.removeItem(PENDING_SUBSCRIPTION_KEY);
      setMessage(
        'PayPal approval is complete. Open Cloud Drop after activation finishes.'
      );
      window.history.replaceState({}, '', '/pricing');
      return;
    }

    if (!orderId) {
      setError('PayPal returned without a usable checkout token.');
      return;
    }

    captureBillingCheckout(orderId)
      .then(response => {
        if (cancelled) return;
        storeEntitlement(response.entitlementToken);
        setMessage('Drop Pass is ready. Open Cloud Drop to upload.');
        window.history.replaceState({}, '', '/pricing');
      })
      .catch(captureError => {
        if (cancelled) return;
        setError(captureError?.message || 'PayPal capture failed');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') === 'cancelled') {
      setError('PayPal checkout was cancelled.');
      window.history.replaceState({}, '', '/pricing');
    }
  }, []);

  const paidPlans = useMemo(
    () => [...plans.passes, plans.pro],
    [plans.passes, plans.pro]
  );

  const startCheckout = async (plan: CloudPlanLimit) => {
    if (!plans.checkoutEnabled || !plan.available) return;
    setCheckoutSku(plan.sku);
    setError(null);
    setMessage(null);

    try {
      const mode = plan.sku === plans.pro.sku ? 'subscription' : 'payment';
      const response: BillingCheckoutResponse = await createBillingCheckout(
        mode,
        plan.sku,
        `${window.location.origin}/pricing`
      );
      if (mode === 'subscription' && response.checkoutId) {
        window.sessionStorage.setItem(
          PENDING_SUBSCRIPTION_KEY,
          response.checkoutId
        );
      }
      window.location.href = response.checkoutUrl;
    } catch (checkoutError: any) {
      setCheckoutSku(null);
      setError(checkoutError?.message || 'Checkout failed');
    }
  };

  return (
    <div className="w-full h-full overflow-y-auto px-4 pt-24 pb-12">
      <motion.div
        key="pricing"
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -18, filter: 'blur(10px)' }}
        className="w-full max-w-6xl mx-auto"
      >
        <div className="mb-6 flex flex-col lg:flex-row lg:items-end lg:justify-between gap-5">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 mb-4">
              <CreditCard className="w-4 h-4 text-emerald-300" />
              <span className="text-[10px] font-bold tracking-[0.2em] text-emerald-300">
                CLOUD DROP PRICING
              </span>
            </div>
            <h2 className="text-4xl md:text-6xl font-black brand-font tracking-tight text-white">
              Pick the transfer path before you upload.
            </h2>
          </div>
          <button
            onClick={onOpenCloud}
            className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-full bg-white text-black font-bold tracking-wider hover:bg-emerald-100 transition-colors"
          >
            <CloudUpload className="w-4 h-4" />
            OPEN CLOUD DROP
          </button>
        </div>

        {(message || error) && (
          <div
            className={`mb-5 border rounded-xl px-4 py-3 text-sm ${
              message
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                : 'bg-red-500/10 border-red-500/30 text-red-200'
            }`}
          >
            {message || error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-4 mb-4">
          <div className="bg-black/45 backdrop-blur-xl border border-cyan-500/25 rounded-2xl p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center">
                <Infinity className="w-5 h-5 text-cyan-300" />
              </div>
              <div>
                <p className="text-white font-bold text-xl">
                  {plans.directP2p.label}
                </p>
                <p className="text-xs text-cyan-200 font-mono">
                  {plans.directP2p.unlimited ? 'unlimited' : 'metered'} · free
                </p>
              </div>
            </div>
            <div className="space-y-3 text-sm text-gray-300">
              <p className="flex items-center gap-2">
                <Check className="w-4 h-4 text-cyan-300" />
                No app-defined file size cap
              </p>
              <p className="flex items-center gap-2">
                <Check className="w-4 h-4 text-cyan-300" />
                Sender and receiver stay online
              </p>
              <p className="flex items-center gap-2">
                <Check className="w-4 h-4 text-cyan-300" />
                Best path for very large media
              </p>
            </div>
          </div>

          <div className="bg-black/45 backdrop-blur-xl border border-emerald-500/25 rounded-2xl p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
                <HardDrive className="w-5 h-5 text-emerald-300" />
              </div>
              <div>
                <p className="text-white font-bold text-xl">
                  {plans.free.label}
                </p>
                <p className="text-xs text-emerald-200 font-mono">
                  {formatBytes(plans.free.maxTotalBytes)} ·{' '}
                  {formatRetention(plans.free.retentionSeconds)} · free
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Metric
                label="share limit"
                value={formatBytes(plans.free.maxTotalBytes)}
              />
              <Metric
                label="file limit"
                value={formatBytes(plans.free.maxFileBytes)}
              />
              <Metric
                label="retention"
                value={formatRetention(plans.free.retentionSeconds)}
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {paidPlans.map(plan => (
            <div
              key={plan.sku}
              className="bg-gray-950/65 backdrop-blur-xl border border-gray-700/70 rounded-2xl p-5 flex flex-col min-h-[280px]"
            >
              <div className="flex-1">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <p className="text-white font-bold text-xl">{plan.label}</p>
                    <p className="text-xs text-gray-500 font-mono mt-1">
                      up to {formatBytes(plan.maxTotalBytes)}
                    </p>
                  </div>
                  <ShieldCheck className="w-5 h-5 text-emerald-300 flex-shrink-0" />
                </div>
                <p className="text-3xl font-black text-emerald-300 mb-5">
                  {formatKrw(plan.priceKrw)}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Metric
                    label="retention"
                    value={formatRetention(plan.retentionSeconds)}
                  />
                  <Metric
                    label="downloads"
                    value={
                      plan.downloadLimit ? `${plan.downloadLimit}` : 'basic'
                    }
                  />
                  <Metric
                    label="file limit"
                    value={formatBytes(plan.maxFileBytes)}
                  />
                  <Metric
                    label="checkout"
                    value={plan.available ? 'ready' : 'soon'}
                  />
                </div>
              </div>
              <button
                disabled={
                  !plans.checkoutEnabled ||
                  !plan.available ||
                  checkoutSku === plan.sku
                }
                onClick={() => startCheckout(plan)}
                className={`mt-5 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl border font-bold tracking-wider transition-colors ${
                  plans.checkoutEnabled && plan.available
                    ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
                    : 'border-gray-700 bg-gray-800/60 text-gray-500 cursor-not-allowed'
                }`}
              >
                {checkoutSku === plan.sku ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ArrowRight className="w-4 h-4" />
                )}
                {checkoutSku === plan.sku
                  ? 'OPENING PAYPAL'
                  : plans.checkoutEnabled && plan.available
                    ? 'CHECKOUT'
                    : 'CHECKOUT SOON'}
              </button>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
};

const Metric: React.FC<{ label: string; value: string }> = ({
  label,
  value,
}) => (
  <div className="bg-black/30 border border-white/5 rounded-xl p-3 min-w-0">
    <p className="text-gray-500 uppercase tracking-widest text-[9px] mb-1 truncate">
      {label}
    </p>
    <p className="text-gray-200 text-sm font-bold truncate">{value}</p>
  </div>
);

export default PricingView;
