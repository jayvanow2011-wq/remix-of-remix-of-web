
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS sender_address text,
  ADD COLUMN IF NOT EXISTS eth_amount numeric,
  ADD COLUMN IF NOT EXISTS tx_hash text;
