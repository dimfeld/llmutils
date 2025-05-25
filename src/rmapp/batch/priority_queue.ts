export interface QueueItem<T> {
  value: T;
  priority: number;
}

export class PriorityQueue<T> {
  private heap: QueueItem<T>[] = [];
  
  enqueue(value: T, priority: number): void {
    const item = { value, priority };
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
  }
  
  dequeue(): T | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop()!.value;
    
    const result = this.heap[0];
    this.heap[0] = this.heap.pop()!;
    this.bubbleDown(0);
    
    return result.value;
  }
  
  peek(): T | undefined {
    return this.heap[0]?.value;
  }
  
  size(): number {
    return this.heap.length;
  }
  
  isEmpty(): boolean {
    return this.heap.length === 0;
  }
  
  clear(): void {
    this.heap = [];
  }
  
  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      
      if (this.heap[parentIndex].priority <= this.heap[index].priority) {
        break;
      }
      
      [this.heap[parentIndex], this.heap[index]] = [this.heap[index], this.heap[parentIndex]];
      index = parentIndex;
    }
  }
  
  private bubbleDown(index: number): void {
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;
      
      if (leftChild < this.heap.length && 
          this.heap[leftChild].priority < this.heap[smallest].priority) {
        smallest = leftChild;
      }
      
      if (rightChild < this.heap.length && 
          this.heap[rightChild].priority < this.heap[smallest].priority) {
        smallest = rightChild;
      }
      
      if (smallest === index) break;
      
      [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
      index = smallest;
    }
  }
  
  // Get all items as array (for debugging)
  toArray(): T[] {
    return this.heap
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map(item => item.value);
  }
}