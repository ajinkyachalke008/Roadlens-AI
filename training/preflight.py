"""Read-only GPU/environment preflight. Never installs drivers or changes global settings."""
import json, subprocess
import torch
def main():
    result={'torch':torch.__version__,'cudaRuntime':torch.version.cuda,'cudaAvailable':torch.cuda.is_available()}
    try:
        result['nvidiaSmi']=subprocess.run(['nvidia-smi','--query-gpu=name,memory.total,memory.free,driver_version','--format=csv,noheader'],capture_output=True,text=True,timeout=10).stdout.strip()
    except (FileNotFoundError,subprocess.TimeoutExpired):result['nvidiaSmi']='unavailable'
    if torch.cuda.is_available():
        x=torch.randn((1,3,320,320),device='cuda');layer=torch.nn.Conv2d(3,8,3).cuda()
        with torch.no_grad(): y=layer(x)
        torch.cuda.synchronize();result['forwardPass']=bool(torch.isfinite(y).all());result['device']=torch.cuda.get_device_name(0)
        del x,y,layer;torch.cuda.empty_cache()
    else:result['forwardPass']='NOT_RUN: isolated installed PyTorch has no available CUDA'
    print(json.dumps(result,indent=2))
if __name__=='__main__':main()
