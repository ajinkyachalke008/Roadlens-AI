"""GPU-only capability checks; importing this module has no CUDA side effects."""
import json
import subprocess
import sys


def preflight(device=0):
    import torch
    if type(device) is not int or device < 0 or not torch.cuda.is_available() or device >= torch.cuda.device_count():
        raise RuntimeError('NVIDIA CUDA device unavailable; worker CPU inference is disabled')
    torch.cuda.set_device(device)
    with torch.inference_mode():
        layer = torch.nn.Conv2d(3, 4, 3).to(device=f'cuda:{device}')
        output = layer(torch.ones((1, 3, 32, 32), device=f'cuda:{device}'))
        torch.cuda.synchronize(device)
        if not output.is_cuda or not bool(torch.isfinite(output).all()):
            raise RuntimeError('Actual CUDA operation failed')
    def command(args):
        try:
            return subprocess.run(args, capture_output=True, text=True, timeout=10, check=True).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return 'unavailable'
    return dict(python=sys.version.split()[0], torch=torch.__version__, cudaRuntime=torch.version.cuda,
                cudnn=torch.backends.cudnn.version(), gpu=torch.cuda.get_device_name(device),
                computeCapability=list(torch.cuda.get_device_capability(device)), device=device,
                totalVramMiB=round(torch.cuda.get_device_properties(device).total_memory/1048576),
                driver=command(['nvidia-smi','--query-gpu=driver_version','--format=csv,noheader']),
                toolkit=command(['nvcc','--version']), actualCudaOperation=True, cpuFallback=False)


if __name__ == '__main__':
    print(json.dumps(preflight(), indent=2))
