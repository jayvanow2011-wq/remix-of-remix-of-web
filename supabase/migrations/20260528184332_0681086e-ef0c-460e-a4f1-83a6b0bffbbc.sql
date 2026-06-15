UPDATE public.builds
SET target_server_url = 'https://project--53c8bcb9-2188-4404-bb05-84e20505f3a8-dev.lovable.app'
WHERE target_server_url ILIKE '%lovableproject.com%'
   OR target_server_url ILIKE 'https://id-preview--%';