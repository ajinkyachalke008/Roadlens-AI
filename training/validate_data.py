"""Validate user-authorized local six-class data and source-group split isolation."""
from pathlib import Path
import argparse,csv,hashlib,json
from PIL import Image
NAMES=['person','bicycle','car','motorcycle','bus','truck']

def validate_yaml(path:Path):
    """Validate the exact local tree Ultralytics will read, never its download hooks."""
    import yaml
    path=path.resolve(strict=True);root=path.parent
    data=yaml.safe_load(path.read_text(encoding='utf-8'))
    if not isinstance(data,dict) or 'download' in data:raise ValueError('Dataset must be a local mapping without download instructions')
    declared=data.get('names')
    if isinstance(declared,dict):
        if set(declared)!=set(range(6)):raise ValueError('Dataset yaml semantic class order mismatch')
        declared=[declared[i] for i in range(6)]
    if declared!=NAMES or data.get('nc',6)!=6:raise ValueError('Dataset yaml semantic class order mismatch')
    # Relative path has exporter working-directory/datasets-dir semantics, not YAML-relative semantics.
    if 'path' in data and (not isinstance(data['path'],str) or not Path(data['path']).is_absolute() or Path(data['path']).resolve()!=root):raise ValueError('Dataset path must be omitted or the absolute YAML directory')
    for split in ('train','val','test'):
        if data.get(split)!=f'images/{split}':raise ValueError('Dataset splits must reference their validated local images directories')
    if data.get('minival'):raise ValueError('Unvalidated minival is unsupported')
    return validate(root)
def validate(root:Path):
    root=root.resolve()
    with (root/'sources.csv').open(newline='',encoding='utf-8') as f: rows=list(csv.DictReader(f))
    required={'image','source_group','split'}
    if not rows or not required.issubset(rows[0]):raise ValueError('sources.csv requires image,source_group,split')
    groups={};hashes={};seen=set();perceptual=[];counts={'train':0,'val':0,'test':0}
    for row in rows:
        split=row['split'];group=row['source_group'];relative=Path(row['image'])
        if split not in counts or not group:raise ValueError('Invalid split or source group')
        if groups.setdefault(group,split)!=split:raise ValueError(f'Source group crosses splits: {group}')
        image=(root/relative).resolve()
        if not image.is_relative_to(root/'images'/split) or image in seen:raise ValueError('Invalid/duplicate image path')
        seen.add(image);counts[split]+=1
        digest=hashlib.sha256(image.read_bytes()).hexdigest()
        if digest in hashes:raise ValueError(f'Duplicate image content: {image.name}')
        hashes[digest]=str(relative)
        with Image.open(image) as opened:
            opened.verify()
        with Image.open(image) as opened:
            gray=list(opened.convert('L').resize((9,8),Image.Resampling.LANCZOS).get_flattened_data())
            dhash=sum(int(gray[y*9+x]>gray[y*9+x+1])<<(y*8+x) for y in range(8) for x in range(8))
        for previous_hash,previous_split,previous_name in perceptual:
            if previous_split!=split and (dhash^previous_hash).bit_count()<=2:raise ValueError(f'Potential near-duplicate across splits: {relative} and {previous_name}; manually resolve before training')
        perceptual.append((dhash,split,str(relative)))
        label=(root/'labels'/split/relative.relative_to(Path('images')/split).with_suffix('.txt')).resolve()
        if not label.is_relative_to(root/'labels'/split):raise ValueError('Label escapes validated dataset')
        lines=label.read_text().splitlines();labels=set()
        for line in lines:
            parts=line.split()
            if len(parts)!=5:raise ValueError(f'Invalid label columns: {label}')
            cls=float(parts[0]);coords=list(map(float,parts[1:]))
            if not cls.is_integer() or not 0<=cls<6 or not all(0<=v<=1 for v in coords) or coords[2]<=0 or coords[3]<=0:raise ValueError(f'Invalid label bounds/classes: {label}')
            x,y,w,h=coords
            if min(x-w/2,y-h/2)<-1e-6 or max(x+w/2,y+h/2)>1+1e-6:raise ValueError(f'Box outside image: {label}')
            key=tuple(parts)
            if key in labels:raise ValueError(f'Duplicate label: {label}')
            labels.add(key)
    # Match installed Ultralytics' image discovery, including files omitted from sources.csv.
    formats={'.avif','.bmp','.dng','.heic','.heif','.jp2','.jpeg','.jpg','.mpo','.png','.tif','.tiff','.webp'}
    actual={p.resolve() for p in (root/'images').rglob('*') if p.suffix.lower() in formats}
    if actual!=seen:raise ValueError('sources.csv does not cover exactly all images')
    if any(n==0 for n in counts.values()):raise ValueError('All train/val/test splits require data')
    return {'classNames':NAMES,'counts':counts,'sourceGroups':groups,'contentSha256':hashes,'nearDuplicateCheck':'dHash64 distance <=2 across splits rejected; heuristic, manual review remains necessary','warning':'Few independent source groups imply weak generalization evidence' if len(groups)<10 else None}
def main():
    parser=argparse.ArgumentParser();parser.add_argument('dataset',type=Path);parser.add_argument('--write-manifest',action='store_true');args=parser.parse_args()
    result=validate(args.dataset)
    if args.write_manifest:(args.dataset/'split_manifest.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))
if __name__=='__main__':main()
