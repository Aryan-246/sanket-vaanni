-- Sanket Vaanni (संकेत वाणी) Storage Policies Migration
-- Version: 20261013000000
-- Target schema: storage.objects
-- Bucket: user-media (private)
--
-- Idempotency: Each policy uses DROP POLICY IF EXISTS before CREATE POLICY
-- so that this migration executes cleanly without duplicate policy errors
-- when these policies were already manually created in the Supabase Dashboard.

-- 1. Ensure Row Level Security is enabled on storage.objects
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 2. SELECT Policy: authenticated users can only view objects in their own folder
DROP POLICY IF EXISTS "user_media_select_own_folder" ON storage.objects;
CREATE POLICY "user_media_select_own_folder"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'user-media'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );

-- 3. INSERT Policy: authenticated users can only upload objects into their own folder
DROP POLICY IF EXISTS "user_media_insert_own_folder" ON storage.objects;
CREATE POLICY "user_media_insert_own_folder"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'user-media'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );

-- 4. UPDATE Policy: authenticated users can only update objects in their own folder
DROP POLICY IF EXISTS "user_media_update_own_folder" ON storage.objects;
CREATE POLICY "user_media_update_own_folder"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'user-media'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'user-media'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );

-- 5. DELETE Policy: authenticated users can only delete objects in their own folder
DROP POLICY IF EXISTS "user_media_delete_own_folder" ON storage.objects;
CREATE POLICY "user_media_delete_own_folder"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'user-media'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );
