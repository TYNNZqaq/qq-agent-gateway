using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;

namespace QQAgent {
    // Out-of-context WinEvents: no DLL injection, UI control, or administrator service.
    public sealed class DesktopStartEvents : IDisposable {
        delegate void WinEvent(IntPtr hook,uint kind,IntPtr window,int obj,int child,uint thread,uint time);
        [StructLayout(LayoutKind.Sequential)] struct Point { public int X,Y; }
        [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr Hwnd; public uint Value; public UIntPtr WParam; public IntPtr LParam; public uint Time; public Point Pt; public uint Private; }
        [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min,uint max,IntPtr module,WinEvent callback,uint process,uint thread,uint flags);
        [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
        [DllImport("user32.dll")] static extern int GetMessage(out Message message,IntPtr window,uint min,uint max);
        [DllImport("user32.dll")] static extern bool PeekMessage(out Message message,IntPtr window,uint min,uint max,uint flags);
        [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread,uint message,UIntPtr wparam,IntPtr lparam);
        [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
        [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,int process);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
        public static string OwnerSid(int pid) {
            IntPtr process=OpenProcess(0x1000,false,pid),token=IntPtr.Zero;
            if(process==IntPtr.Zero)return null;
            try { if(!OpenProcessToken(process,8,out token))return null; using(var identity=new WindowsIdentity(token))return identity.User.Value; }
            finally { if(token!=IntPtr.Zero)CloseHandle(token); CloseHandle(process); }
        }
        public readonly AutoResetEvent Available=new AutoResetEvent(false);
        readonly ManualResetEvent ready=new ManualResetEvent(false);
        readonly ConcurrentQueue<int> queue=new ConcurrentQueue<int>();
        readonly Thread thread;
        readonly FileSystemWatcher preferences;
        readonly WinEvent callback;
        uint nativeThread;
        Exception failure;
        volatile bool disposed;
        public DesktopStartEvents(string directory) {
            callback=OnWindow;
            preferences=new FileSystemWatcher(directory,"desktop-autoconnect.json");
            preferences.NotifyFilter=NotifyFilters.FileName|NotifyFilters.LastWrite|NotifyFilters.Size;
            preferences.Changed+=OnPreference; preferences.Created+=OnPreference;
            preferences.Deleted+=OnPreference; preferences.Renamed+=(s,e)=>SignalPreference();
            preferences.EnableRaisingEvents=true;
            thread=new Thread(Run); thread.IsBackground=true; thread.SetApartmentState(ApartmentState.STA);thread.Start();
            if(!ready.WaitOne(5000)) { Dispose();throw new InvalidOperationException("DESKTOP_EVENTS_TIMEOUT"); }
            if(failure!=null) { Dispose();throw new InvalidOperationException("DESKTOP_EVENTS_UNAVAILABLE",failure); }
        }
        void SignalPreference() { if(!disposed){queue.Enqueue(0);Available.Set();} }
        void OnPreference(object sender,FileSystemEventArgs e) { SignalPreference(); }
        void OnWindow(IntPtr hook,uint kind,IntPtr window,int obj,int child,uint eventThread,uint time) {
            if(disposed||window==IntPtr.Zero||obj!=0||child!=0||GetAncestor(window,2)!=window)return;
            uint pid;GetWindowThreadProcessId(window,out pid);
            try { using(var p=Process.GetProcessById((int)pid)) {
                if(!String.Equals(p.ProcessName,"ChatGPT",StringComparison.OrdinalIgnoreCase)&&!String.Equals(p.ProcessName,"Codex",StringComparison.OrdinalIgnoreCase))return;
                queue.Enqueue((int)pid);Available.Set();
            }}catch(ArgumentException){}catch(InvalidOperationException){}
        }
        void Run() {
            IntPtr[] hooks=new IntPtr[3];
            GCHandle callbackRoot=GCHandle.Alloc(callback);
            try {
                nativeThread=GetCurrentThreadId();Message msg;PeekMessage(out msg,IntPtr.Zero,0,0,0);
                uint[] kinds={3,0x8000,0x8002};
                for(int i=0;i<kinds.Length;i++) { hooks[i]=SetWinEventHook(kinds[i],kinds[i],IntPtr.Zero,callback,0,0,2);if(hooks[i]==IntPtr.Zero)throw new InvalidOperationException(); }
                ready.Set();
                while(GetMessage(out msg,IntPtr.Zero,0,0)>0) { TranslateMessage(ref msg);DispatchMessage(ref msg); }
            }catch(Exception e){failure=e;ready.Set();}
            finally { foreach(var hook in hooks)if(hook!=IntPtr.Zero)UnhookWinEvent(hook);callbackRoot.Free(); }
        }
        public int[] Drain() { var values=new System.Collections.Generic.HashSet<int>();int value;while(queue.TryDequeue(out value))values.Add(value);return new System.Collections.Generic.List<int>(values).ToArray(); }
        public void Dispose() { if(disposed)return;disposed=true;preferences.Dispose();if(nativeThread!=0)PostThreadMessage(nativeThread,0x12,UIntPtr.Zero,IntPtr.Zero);if(thread!=null&&thread.IsAlive)thread.Join(5000); }
    }
}
