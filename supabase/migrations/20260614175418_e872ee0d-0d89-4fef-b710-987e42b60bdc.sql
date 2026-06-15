DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='Avatars public read') THEN
    CREATE POLICY "Avatars public read" ON storage.objects FOR SELECT USING (bucket_id='avatars');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='Avatars owner insert') THEN
    CREATE POLICY "Avatars owner insert" ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id='avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='Avatars owner update') THEN
    CREATE POLICY "Avatars owner update" ON storage.objects FOR UPDATE TO authenticated
      USING (bucket_id='avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='Avatars owner delete') THEN
    CREATE POLICY "Avatars owner delete" ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id='avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
  END IF;
END $$;