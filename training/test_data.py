"""Synthetic files test validator behavior, not detector or training accuracy."""
import unittest,tempfile,csv
from pathlib import Path
import numpy as np
from PIL import Image
from validate_data import validate
class DataTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.rows=[]
        for i,split in enumerate(['train','val','test']):
            (self.root/'images'/split).mkdir(parents=True);(self.root/'labels'/split).mkdir(parents=True)
            Image.fromarray(np.random.default_rng(i).integers(0,256,(40,40,3),dtype=np.uint8)).save(self.root/f'images/{split}/a.png')
            (self.root/f'labels/{split}/a.txt').write_text('2 0.5 0.5 0.2 0.2\n');self.rows.append({'image':f'images/{split}/a.png','split':split,'source_group':f'clip-{i}'})
        self.save()
    def save(self):
        with (self.root/'sources.csv').open('w',newline='') as f:w=csv.DictWriter(f,fieldnames=['image','split','source_group']);w.writeheader();w.writerows(self.rows)
    def tearDown(self):self.tmp.cleanup()
    def test_valid(self):self.assertEqual(validate(self.root)['counts'],{'train':1,'val':1,'test':1})
    def test_group_leakage(self):
        self.rows[1]['source_group']='clip-0';self.save()
        with self.assertRaisesRegex(ValueError,'crosses splits'):validate(self.root)
    def test_bad_class(self):
        (self.root/'labels/train/a.txt').write_text('7 0.5 0.5 0.2 0.2')
        with self.assertRaisesRegex(ValueError,'classes'):validate(self.root)
    def test_duplicate_image(self):
        (self.root/'images/test/a.png').write_bytes((self.root/'images/train/a.png').read_bytes())
        with self.assertRaisesRegex(ValueError,'Duplicate image'):validate(self.root)
    def test_empty_negative(self):
        (self.root/'labels/train/a.txt').write_text('');self.assertEqual(validate(self.root)['counts']['train'],1)
    def test_unlisted_exporter_image_format(self):
        Image.new('RGB',(20,20)).save(self.root/'images/train/unlisted.bmp')
        with self.assertRaisesRegex(ValueError,'cover exactly'):validate(self.root)
if __name__=='__main__':unittest.main()
