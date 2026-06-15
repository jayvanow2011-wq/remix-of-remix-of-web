
-- free_claims table
CREATE TABLE public.free_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

GRANT SELECT, INSERT ON public.free_claims TO authenticated;
GRANT ALL ON public.free_claims TO service_role;

ALTER TABLE public.free_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view free claims" ON public.free_claims
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Users can claim once" ON public.free_claims
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- ad_spots table
CREATE TABLE public.ad_spots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_number int NOT NULL UNIQUE,
  title text NOT NULL DEFAULT '',
  short_description text NOT NULL DEFAULT '',
  long_description text NOT NULL DEFAULT '',
  front_image text,
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  buttons jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  is_for_sale boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ad_spots TO authenticated;
GRANT ALL ON public.ad_spots TO service_role;

ALTER TABLE public.ad_spots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view active spots" ON public.ad_spots
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage all spots" ON public.ad_spots
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Owners can update their spot" ON public.ad_spots
  FOR UPDATE TO authenticated USING (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

CREATE TRIGGER update_ad_spots_updated_at
  BEFORE UPDATE ON public.ad_spots
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Seed 10 fixed ad slots
INSERT INTO public.ad_spots (slot_number, title, short_description, is_for_sale)
VALUES
  (1, 'Ad Spot #1', 'Premium advertising slot', true),
  (2, 'Ad Spot #2', 'Premium advertising slot', true),
  (3, 'Ad Spot #3', 'Premium advertising slot', true),
  (4, 'Ad Spot #4', 'Premium advertising slot', true),
  (5, 'Ad Spot #5', 'Premium advertising slot', true),
  (6, 'Ad Spot #6', 'Premium advertising slot', true),
  (7, 'Ad Spot #7', 'Premium advertising slot', true),
  (8, 'Ad Spot #8', 'Premium advertising slot', true),
  (9, 'Ad Spot #9', 'Premium advertising slot', true),
  (10, 'Ad Spot #10', 'Premium advertising slot', true);
